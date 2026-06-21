/**
 * qfg-7h5d.2.3 — last-known-good (LKG) localStorage cache (spec 5h).
 *
 * sdk-javascript had no client-side persistence (in-memory ETag only) and the
 * loader threw when every API URL failed. The frontend is the primary consumer
 * of the secondary during a Fly outage (a browser is a fresh client on every
 * page load), and the one accepted failure mode is a simultaneous GitHub+Fly
 * outage. This cache lets a RETURNING visitor survive even that: on a page load
 * where all URLs fail, serve the config last successfully held, marked stale
 * (reason STALE), instead of throwing.
 *
 * Jest runs in the node environment (no localStorage), so we inject an
 * in-memory shim. The watermark rule applies to the cache too: an older live
 * response (dropped by the reject-older guard) never reaches the cache, so a
 * later offline load can't be served a downgraded payload.
 */

const { Quonfig } = require("../dist/quonfig");

const ALICE = { user: { key: "alice" } };
const SDK_KEY = "qf_pk_development_test";
const URLS = ["https://primary.quonfig-staging.com", "https://secondary.quonfig-staging.com"];

function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
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

// A fetch that returns the given generation/value for every URL (primary
// answers fast, so the secondary is suppressed).
const okFetch = (generation, value) => jest.fn(async () => genResponse(generation, value));
// A fetch where every URL is unreachable.
const deadFetch = () => jest.fn(async () => Promise.reject(new Error("offline")));

const newQuonfig = async (overrides = {}) => {
  const q = new Quonfig();
  await q.init({
    sdkKey: SDK_KEY,
    context: ALICE,
    apiUrls: URLS,
    hedgeDelay: 40,
    timeout: 500,
    collectEvaluationSummaries: false,
    ...overrides,
  });
  return q;
};

describe("last-known-good localStorage cache (5h)", () => {
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

  test("a successful load persists; a later session with all URLs dead serves it stale instead of throwing", async () => {
    // Session 1: online, establishes gen 42 and persists it to the LKG cache.
    global.fetch = okFetch(42, true);
    const q1 = await newQuonfig();
    expect(q1.get("feature")).toBe(true);
    expect(q1.stale).toBe(false);

    // Session 2: a NEW client (empty in-memory state) with every URL dead.
    // Must serve the cached payload — not throw — and mark it stale.
    global.fetch = deadFetch();
    const q2 = await newQuonfig();
    expect(q2.stale).toBe(true);
    expect(q2.get("feature")).toBe(true); // served from the LKG cache
    expect(q2.getDetails("feature").reason).toBe("STALE");
  });

  test("a fresh network load after a stale serve heals forward and clears stale", async () => {
    global.fetch = okFetch(42, true);
    await newQuonfig(); // seed the cache

    global.fetch = deadFetch();
    const q = await newQuonfig();
    expect(q.stale).toBe(true);
    expect(q.get("feature")).toBe(true);

    // Network recovers with a newer generation: heal forward, clear stale.
    global.fetch = okFetch(43, false);
    await q.updateContext(ALICE);
    expect(q.stale).toBe(false);
    expect(q.get("feature")).toBe(false);
    expect(q.getDetails("feature").reason).not.toBe("STALE");
  });

  test("the watermark rule applies to the cache: an older live response never downgrades it", async () => {
    // Session 1 establishes gen 42 (persisted), then sees an OLDER gen 41 that
    // the reject-older guard drops — so it must never reach the cache.
    global.fetch = okFetch(42, true);
    const q1 = await newQuonfig();
    expect(q1.get("feature")).toBe(true);

    global.fetch = okFetch(41, false); // older — guard rejects, value stays true
    await q1.updateContext(ALICE);
    expect(q1.get("feature")).toBe(true);

    // Session 2 offline: must serve gen 42's value (true), NOT the rejected 41.
    global.fetch = deadFetch();
    const q2 = await newQuonfig();
    expect(q2.stale).toBe(true);
    expect(q2.get("feature")).toBe(true);
  });

  test("no cache + all URLs fail still rejects (preserves the throw when there is nothing to serve)", async () => {
    global.fetch = deadFetch(); // empty localStorage, nothing cached
    const q = new Quonfig();
    await expect(
      q.init({
        sdkKey: SDK_KEY,
        context: ALICE,
        apiUrls: URLS,
        hedgeDelay: 40,
        timeout: 500,
        collectEvaluationSummaries: false,
      })
    ).rejects.toThrow();
  });

  test("localStorage absent: cache is inert (no crash on persist, rejects on all-fail)", async () => {
    delete global.localStorage;
    // A successful load must not crash trying to persist without localStorage.
    global.fetch = okFetch(7, true);
    const q1 = await newQuonfig();
    expect(q1.get("feature")).toBe(true);

    // And with no storage there is nothing to serve, so all-fail still rejects.
    global.fetch = deadFetch();
    const q2 = new Quonfig();
    await expect(
      q2.init({
        sdkKey: SDK_KEY,
        context: ALICE,
        apiUrls: URLS,
        hedgeDelay: 40,
        timeout: 500,
        collectEvaluationSummaries: false,
      })
    ).rejects.toThrow();
  });
});
