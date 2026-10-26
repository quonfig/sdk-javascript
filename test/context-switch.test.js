/**
 * qfg-xiub: a context switch must never keep serving the previous user's
 * values as authoritative.
 *
 * Before 2.0, `updateContext(bob)` changed `contexts` but left alice's
 * `_configs` in place until bob's fetch landed. When every leg failed, bob
 * kept alice's values for good, reported TARGETING_MATCH with stale:false
 * (alice's admin-panel=true was served to bob).
 *
 * 2.0 follows sdk-swift (Quonfig.swift updateContext): the switch itself
 * swaps what is served, before the fetch, to the new context's last-known-good
 * copy (stale) or to nothing (caller defaults), and notifies subscribers.
 */

const { Quonfig } = require("../dist/quonfig");
const { encodeContexts } = require("../dist/context");
const { writeLkg } = require("../dist/lkgCache");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const ALICE = { user: { key: "alice" } };
const BOB = { user: { key: "bob" } };

const userOf = (url) => [ALICE, BOB].find((ctx) => url.includes(encodeContexts(ctx))).user.key;

const payloadFor = (user, generation = 7) => ({
  evaluations: {
    "admin-panel": {
      value: { type: "bool", value: user === "alice" },
      configId: "cfg-admin",
      configType: "feature_flag",
      valueType: "bool",
      reason: "TARGETING_MATCH",
      ruleIndex: 0,
    },
    greeting: { value: { type: "string", value: `hello ${user}` }, configId: "cfg-greeting" },
  },
  meta: { version: `gen-${generation}`, environment: "Production", generation },
});

const okResponse = (url) =>
  new Response(JSON.stringify(payloadFor(userOf(url))), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function fakeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

describe("updateContext: a switch never serves the previous context's values", () => {
  let originalFetch;
  let originalLS;
  let q;
  let networkUp;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
      writable: true,
    });
    networkUp = true;
    global.fetch = jest.fn(async (url) => {
      if (!networkUp) throw new TypeError("Failed to fetch");
      return okResponse(url);
    });
  });

  afterEach(async () => {
    await q?.close();
    global.fetch = originalFetch;
    if (originalLS) Object.defineProperty(globalThis, "localStorage", originalLS);
    else delete globalThis.localStorage;
    jest.restoreAllMocks();
  });

  const initAs = async (context) => {
    q = new Quonfig();
    await q.init({
      sdkKey: SDK_KEY,
      context,
      apiUrls: [PRIMARY],
      collectEvaluationSummaries: false,
    });
  };

  test("a failed switch to a never-seen context serves defaults, not alice's values", async () => {
    await initAs(ALICE);
    expect(q.isEnabled("admin-panel")).toBe(true);

    networkUp = false;
    await q.updateContext(BOB).catch(() => {});

    expect(q.contexts).toEqual(BOB);
    expect(q.get("admin-panel")).toBeUndefined();
    expect(q.isEnabled("admin-panel")).toBe(false);
    expect(q.get("greeting")).toBeUndefined();
    const details = q.getDetails("admin-panel");
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("FLAG_NOT_FOUND");
  });

  test("a failed switch to a previously seen context serves its cached copy, marked stale", async () => {
    await initAs(ALICE);
    // The last-known-good cache is one slot per SDK key; seed it with bob's
    // copy (as an earlier session for bob would have left it).
    writeLkg(SDK_KEY, encodeContexts(BOB), { generation: 7, payload: payloadFor("bob") });

    networkUp = false;
    await q.updateContext(BOB).catch(() => {});

    expect(q.get("greeting")).toBe("hello bob");
    expect(q.isEnabled("admin-panel")).toBe(false);
    expect(q.stale).toBe(true);
    expect(q.getDetails("greeting").reason).toBe("STALE");
  });

  test("while the switch's fetch is in flight, alice's values are already gone", async () => {
    await initAs(ALICE);
    let release;
    global.fetch = jest.fn(async (url) => {
      await new Promise((r) => {
        release = r;
      });
      return okResponse(url);
    });

    const pending = q.updateContext(BOB);
    expect(q.get("admin-panel")).toBeUndefined();
    expect(q.get("greeting")).toBeUndefined();

    release();
    await pending;
    expect(q.get("greeting")).toBe("hello bob");
    expect(q.isEnabled("admin-panel")).toBe(false);
    expect(q.getDetails("greeting").reason).toBe("STATIC");
  });

  test("subscribers hear about the switch before the fetch settles", async () => {
    await initAs(ALICE);
    networkUp = false;
    const seen = [];
    q.subscribe(() => seen.push(q.get("greeting")));
    const pending = q.updateContext(BOB).catch(() => {});
    expect(seen).toContain(undefined);
    await pending;
  });

  test("skipLoad switches stop serving alice's values too", async () => {
    await initAs(ALICE);
    await q.updateContext(BOB, true);
    expect(q.get("greeting")).toBeUndefined();
    expect(q.isEnabled("admin-panel")).toBe(false);
  });

  test("re-sending the same context does not clear what is served", async () => {
    await initAs(ALICE);
    networkUp = false;
    await q.updateContext({ user: { key: "alice" } }).catch(() => {});
    expect(q.get("greeting")).toBe("hello alice");
    expect(q.isEnabled("admin-panel")).toBe(true);
  });
});
