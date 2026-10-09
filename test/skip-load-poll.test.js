/**
 * qfg-goi1.2.48: `updateContext(ctx, true)` followed by `poll()` must fetch,
 * install and persist the NEW context's values.
 *
 * `skipLoad` changed `_contexts` but not `loader.contexts`, and `poll()` never
 * synced it (only `load()` did). So poll()'s first fetch went out for the OLD
 * context and was installed under the NEW context's signature, and written to
 * the last-known-good slot under the new context's hash. Later ticks fetched
 * the right context, but at the same generation the reject-older guard dropped
 * them as "equal": user B kept user A's flags until the next publish, and an
 * offline reload for B served A's values marked stale.
 */

const { Quonfig } = require("../dist/quonfig");
const { encodeContexts } = require("../dist/context");
const { readLkg } = require("../dist/lkgCache");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";
const ALICE = { user: { key: "alice" } };
const BOB = { user: { key: "bob" } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userOf = (url) => [ALICE, BOB].find((ctx) => url.includes(encodeContexts(ctx))).user.key;

const payloadFor = (user, generation = 7) => ({
  evaluations: { greeting: { value: { type: "string", value: `hello ${user}` } } },
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

describe("updateContext(ctx, true) then poll()", () => {
  let originalFetch;
  let originalLS;
  let q;
  beforeEach(() => {
    originalFetch = global.fetch;
    originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    jest.spyOn(console, "warn").mockImplementation(() => {});
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    q?.stopPolling();
    global.fetch = originalFetch;
    if (originalLS) Object.defineProperty(globalThis, "localStorage", originalLS);
    else delete globalThis.localStorage;
    console.warn.mockRestore();
  });

  test("poll fetches, installs and persists the new context's values", async () => {
    const fetched = [];
    global.fetch = jest.fn(async (url) => {
      fetched.push(userOf(url));
      return okResponse(url);
    });

    q = new Quonfig();
    await q.init({
      sdkKey: SDK_KEY,
      context: ALICE,
      apiUrls: [PRIMARY],
      collectEvaluationSummaries: false,
    });
    expect(q.get("greeting")).toBe("hello alice");

    await q.updateContext(BOB, true);
    await q.poll({ frequencyInMs: 60_000 });

    expect(fetched).toEqual(["alice", "bob"]);
    expect(q.get("greeting")).toBe("hello bob");
    expect(readLkg(SDK_KEY, encodeContexts(BOB)).payload.evaluations.greeting.value.value).toBe(
      "hello bob"
    );
  });

  test("a load in flight when skipLoad switches the context finishes for the context it was started for", async () => {
    // The primary for alice is slow, so the hedge fires the secondary after
    // updateContext(bob, true) has run. Both legs of that load belong to alice:
    // the secondary must not fetch bob and report it under alice's signature.
    const fetched = [];
    global.fetch = jest.fn(async (url) => {
      fetched.push(`${url.includes("//primary.") ? "primary" : "secondary"}:${userOf(url)}`);
      if (url.includes("//primary.")) await sleep(150);
      return okResponse(url);
    });

    q = new Quonfig();
    const init = q.init({
      sdkKey: SDK_KEY,
      context: ALICE,
      apiUrls: [PRIMARY, SECONDARY],
      hedgeDelay: 50,
      timeout: 1000,
      collectEvaluationSummaries: false,
    });
    await q.updateContext(BOB, true);
    await init;
    await sleep(200);

    expect(fetched).toEqual(["primary:alice", "secondary:alice"]);
    expect(q.get("greeting")).toBe("hello alice");
    expect(readLkg(SDK_KEY, encodeContexts(BOB))).toBeUndefined();
  });
});
