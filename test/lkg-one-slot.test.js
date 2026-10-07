/**
 * qfg-goi1.2.6 item 8: the last-known-good cache keeps ONE slot per sdkKey.
 *
 * v1 wrote `quonfig.lkg.v1:<sdkKey>:<base64(context)>` for every distinct
 * context and never removed anything: localStorage grew without bound (100
 * contexts x a 200-flag payload ~ 6.6MB, past the ~5MB origin quota, which then
 * breaks the customer's own setItem calls) and the raw context (emails, ids)
 * sat in the key. LKG exists for the returning visitor in a total outage, and
 * that visitor is the last context the browser held, so one slot is enough:
 * key `quonfig.lkg.v2:<sdkKey>`, value {ctxHash, generation, payload}, served
 * only when the context hash matches. The first v2 write removes the old v1
 * keys for that sdkKey.
 */

const { Quonfig } = require("../dist/quonfig");

const SDK_KEY = "qf_pk_development_test";
const URLS = ["https://primary.quonfig-staging.com"];
const ALICE = { user: { key: "alice", email: "alice@example.org" } };
const BOB = { user: { key: "bob", email: "bob@example.org" } };

// A localStorage shim with the enumeration API (length / key(i)).
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
    clear: () => store.clear(),
    _store: store,
  };
}

const okFetch = (generation = 5) =>
  jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          evaluations: { feature: { value: { type: "bool", value: true } } },
          meta: { version: `gen-${generation}`, environment: "Production", generation },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
const deadFetch = () => jest.fn(async () => Promise.reject(new Error("offline")));

const init = (q, context) =>
  q.init({
    sdkKey: SDK_KEY,
    context,
    apiUrls: URLS,
    timeout: 500,
    collectEvaluationSummaries: false,
  });

const lkgKeys = (ls) => Array.from(ls._store.keys()).filter((k) => k.startsWith("quonfig.lkg."));

describe("last-known-good cache: one slot per sdkKey", () => {
  let originalFetch;
  let originalLS;
  beforeEach(() => {
    originalFetch = global.fetch;
    originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
      writable: true,
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalLS) Object.defineProperty(globalThis, "localStorage", originalLS);
    else delete globalThis.localStorage;
    console.warn.mockRestore();
  });

  test("100 contexts leave exactly one entry, and the key does not hold the context", async () => {
    global.fetch = okFetch();
    const q = new Quonfig();
    await init(q, ALICE);
    for (let i = 0; i < 100; i += 1) {
      await q.updateContext({ user: { key: `u${i}`, email: `user${i}@example.org` } });
    }
    const keys = lkgKeys(globalThis.localStorage);
    expect(keys).toEqual([`quonfig.lkg.v2:${SDK_KEY}`]);
    expect(globalThis.localStorage.getItem(keys[0])).not.toContain("user99@example.org");
  });

  test("the first write removes this sdkKey's v1 entries and nothing else", async () => {
    const ls = globalThis.localStorage;
    ls.setItem(`quonfig.lkg.v1:${SDK_KEY}:eyJ1c2VyIjp7fX0%3D`, "{}");
    ls.setItem(`quonfig.lkg.v1:${SDK_KEY}:eyJvdGhlciI6e319`, "{}");
    ls.setItem("quonfig.lkg.v1:qf_pk_other_key:eyJ1c2VyIjp7fX0%3D", "{}");
    ls.setItem("customer.app.draft", "keep me");

    global.fetch = okFetch();
    await init(new Quonfig(), ALICE);

    expect(Array.from(ls._store.keys()).sort()).toEqual(
      [
        "customer.app.draft",
        "quonfig.lkg.v1:qf_pk_other_key:eyJ1c2VyIjp7fX0%3D",
        `quonfig.lkg.v2:${SDK_KEY}`,
      ].sort()
    );
  });

  test("an outage serves the cached payload for the same context, stale", async () => {
    global.fetch = okFetch(42);
    await init(new Quonfig(), ALICE);

    global.fetch = deadFetch();
    const q = new Quonfig();
    await init(q, ALICE);
    expect(q.stale).toBe(true);
    expect(q.get("feature")).toBe(true);
  });

  test("an outage with a different context serves nothing (rejects)", async () => {
    global.fetch = okFetch(42);
    await init(new Quonfig(), ALICE);

    global.fetch = deadFetch();
    await expect(init(new Quonfig(), BOB)).rejects.toThrow();
  });
});
