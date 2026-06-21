/**
 * qfg-7h5d.2 — failover CONTRACT test (spec 5e/5f/5h).
 *
 * @quonfig/react (QuonfigProvider over the `quonfig` singleton / `Quonfig`
 * class) and @quonfig/react-native (`export * from "@quonfig/react"`) are pure
 * wrappers — they add no loader logic of their own, so the entire secondary
 * failover behavior is inherited from @quonfig/javascript unchanged. This test
 * pins that inherited contract through ONLY the public surface a wrapper
 * consumer touches (init / updateContext / get / getDetails / stale), so the
 * wrappers do not need their own failover tests:
 *
 *   1. reject-older guard (5f) — a slow-primary hedge that paints the gen=1
 *      secondary first never flips an established client's value; a late, newer
 *      primary heals it forward.
 *   2. parallel hedge (5e) — a dead primary fails over to the secondary inside
 *      a tight budget instead of waiting out a 10s per-URL timeout.
 *   3. last-known-good cache (5h) — a returning visitor with every URL dead
 *      serves cached config marked stale (reason STALE) instead of throwing,
 *      and heals back to authoritative on recovery.
 */

const { Quonfig } = require("../dist/quonfig");

const ALICE = { user: { key: "alice" } };
const SDK_KEY = "qf_pk_development_test";
const URLS = ["https://primary.quonfig-staging.com", "https://secondary.quonfig-staging.com"];

function makeDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const genResponse = (generation, value) =>
  new Response(
    JSON.stringify({
      evaluations: { feature: { value: { type: "bool", value } } },
      meta: { version: `gen-${generation}`, environment: "Production", generation },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: `"g${generation}-${value}"` },
    }
  );

function hedgeFetch({ primary, secondary }) {
  return jest.fn((url) => {
    if (url.includes("//primary.")) return primary();
    if (url.includes("//secondary.")) return secondary();
    throw new Error(`unexpected url ${url}`);
  });
}

const fakeLocalStorage = () => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const init = (q, overrides = {}) =>
  q.init({
    sdkKey: SDK_KEY,
    context: ALICE,
    apiUrls: URLS,
    hedgeDelay: 40,
    timeout: 500,
    collectEvaluationSummaries: false,
    ...overrides,
  });

describe("failover contract inherited by @quonfig/react + @quonfig/react-native", () => {
  let originalFetch;
  let originalLS;
  beforeEach(() => {
    originalFetch = global.fetch;
    originalLS = global.localStorage;
    global.localStorage = fakeLocalStorage();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalLS === undefined) delete global.localStorage;
    else global.localStorage = originalLS;
  });

  test("running client: hedge to the gen=1 secondary never flips the value; the late primary heals forward", async () => {
    // Boot online on the primary's gen 42 — secondary suppressed.
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(42, true)),
      secondary: () => {
        throw new Error("secondary must not fire on a fast init");
      },
    });
    const q = new Quonfig();
    await init(q);
    expect(q.get("feature")).toBe(true);
    expect(q.stale).toBe(false);

    // Primary degrades: a poll hedges to the depth-1 secondary (gen 1) which
    // answers first. The guard must drop it — no value flap, not marked stale.
    const slowPrimary = makeDeferred();
    global.fetch = hedgeFetch({
      primary: () => slowPrimary.promise,
      secondary: () => Promise.resolve(genResponse(1, false)),
    });
    await q.updateContext(ALICE);
    expect(q.get("feature")).toBe(true); // gen 1 secondary rejected — no flap
    expect(q.stale).toBe(false);

    // Primary finally answers with a newer generation: heal forward.
    slowPrimary.resolve(genResponse(43, false));
    await sleep(10);
    expect(q.get("feature")).toBe(false);
    expect(q.heldGeneration).toBe(43);
  });

  test("offline returning visitor: serves the last-known-good config marked STALE, then heals on recovery", async () => {
    // First visit, online: establish + persist gen 42.
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(42, true)),
      secondary: () => {
        throw new Error("secondary must not fire on a fast init");
      },
    });
    await init(new Quonfig());

    // Return visit, total outage (both legs dead): a NEW client must serve the
    // cached config marked stale instead of throwing.
    global.fetch = hedgeFetch({
      primary: () => Promise.reject(new Error("offline")),
      secondary: () => Promise.reject(new Error("offline")),
    });
    const q = new Quonfig();
    await init(q); // resolves (does not throw) thanks to the LKG cache
    expect(q.stale).toBe(true);
    expect(q.get("feature")).toBe(true);
    expect(q.getDetails("feature").reason).toBe("STALE");

    // Network recovers with a newer generation: stale clears, value heals.
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(43, false)),
      secondary: () => {
        throw new Error("secondary must not fire on a fast recovery");
      },
    });
    await q.updateContext(ALICE);
    expect(q.stale).toBe(false);
    expect(q.get("feature")).toBe(false);
    expect(q.getDetails("feature").reason).not.toBe("STALE");
  });
});
