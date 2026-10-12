/**
 * qfg-goi1.10.12 (#26, #28).
 *
 * #26: two overlapping init() calls each build their own Loader, so the
 * superseded-load guard (qfg-goi1.2.7) does not cover them. When the OLDER
 * init's response lands last, applyLoaderResult saw a differing signature as a
 * "context switch" and installed A's values while `contexts` said B. A result
 * now installs only when it was fetched for the current context.
 *
 * #28: `stale` was only assigned inside an install, and an equal-generation
 * success does not install, so a client that served last-known-good stayed
 * STALE forever once the network recovered at the same generation.
 */

const { Quonfig } = require("../dist/quonfig");
const { encodeContexts } = require("../dist/context");
const { writeLkg } = require("../dist/lkgCache");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
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

const initOpts = (context) => ({
  sdkKey: SDK_KEY,
  context,
  apiUrls: [PRIMARY],
  collectEvaluationSummaries: false,
});

describe("results install only for the context they were fetched for", () => {
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

  test("overlapping init(): the newer context wins when the older response lands last", async () => {
    // alice's fetch is slow, bob's is fast: alice's lands after bob's.
    global.fetch = jest.fn(async (url) => {
      await sleep(userOf(url) === "alice" ? 60 : 5);
      return okResponse(url);
    });
    q = new Quonfig();
    const a = q.init(initOpts(ALICE));
    const b = q.init(initOpts(BOB));
    await Promise.all([a, b]);
    await sleep(80);

    expect(q.contexts).toEqual(BOB);
    expect(q.get("greeting")).toBe("hello bob");
  });

  test("shouldLog({loggerPath}) during init does not drop init's own result", async () => {
    global.fetch = jest.fn(async (url) => {
      await sleep(20);
      return okResponse(url);
    });
    q = new Quonfig();
    const pending = q.init({ ...initOpts(ALICE), loggerKey: "log-level.my-app" });
    q.shouldLog({ loggerPath: "com.example.Foo", desiredLevel: "INFO", defaultLevel: "WARN" });
    await pending;

    expect(q.get("greeting")).toBe("hello alice");
  });

  test("stale clears on an equal-generation network success", async () => {
    // Seed bob's last-known-good at generation 7, then fail every leg so init
    // serves it stale.
    writeLkg(SDK_KEY, encodeContexts(BOB), { generation: 7, payload: payloadFor("bob", 7) });
    let online = false;
    global.fetch = jest.fn(async (url) => {
      if (!online) throw new TypeError("Failed to fetch");
      return okResponse(url);
    });
    q = new Quonfig();
    await q.init(initOpts(BOB));
    expect(q.stale).toBe(true);
    expect(q.get("greeting")).toBe("hello bob");

    // The network recovers at the SAME generation (7): nothing new to install,
    // but the held values are now confirmed live.
    online = true;
    await q.updateContext(BOB);
    expect(q.stale).toBe(false);
  });
});
