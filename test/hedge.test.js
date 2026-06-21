/**
 * qfg-7h5d.2.2 — parallel hedge in the loader (spec 5e).
 *
 * The loader used to fail over primary->secondary strictly SEQUENTIALLY with a
 * 10s per-URL timeout: a page loaded against a hung primary waited the full 10s
 * before even trying the secondary. The hedge fires the primary first and, only
 * if it is slow (no answer within the hedge delay) or errors fast, fires the
 * secondary IN PARALLEL — and DRAINS every leg that returns through the caller's
 * reject-older guard, so a late, newer primary still wins over a stale secondary
 * that painted first (highest generation wins, not first-arrival — spec 5f.1).
 *
 * These drive the loader directly with deferred fetch promises so leg timing is
 * deterministic, plus one Quonfig integration test proving the hedge cannot
 * regress an established client (the guard-before-hedge safety property).
 */

const Loader = require("../dist/loader").default;
const { Quonfig } = require("../dist/quonfig");

const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

// A fetch mock that routes by host (primary vs secondary) to caller-supplied
// thunks, recording every URL it was asked for.
function hedgeFetch({ primary, secondary }) {
  const calls = [];
  const fn = jest.fn((url) => {
    calls.push(url);
    if (url.includes("//primary.")) return primary();
    if (url.includes("//secondary.")) return secondary();
    throw new Error(`unexpected url ${url}`);
  });
  fn.calls = calls;
  fn.secondaryCalls = () => calls.filter((u) => u.includes("//secondary."));
  fn.primaryCalls = () => calls.filter((u) => u.includes("//primary."));
  return fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const loaderParams = (overrides) => ({
  sdkKey: "qf_pk_development_test",
  contexts: { user: { key: "alice" } },
  apiUrls: [PRIMARY, SECONDARY],
  hedgeDelay: 40,
  timeout: 1000,
  ...overrides,
});

describe("hedged loader (5e)", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a fast primary success suppresses the secondary entirely (zero extra requests)", async () => {
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(42, true)),
      secondary: () => {
        throw new Error("secondary must not be fired when the primary answers fast");
      },
    });

    const loader = new Loader(loaderParams());
    const drained = [];
    await loader.loadHedged((r) => drained.push(r));

    expect(global.fetch.secondaryCalls()).toHaveLength(0);
    expect(drained).toHaveLength(1);
    expect(drained[0].payload.meta.generation).toBe(42);
  });

  test("a dead primary fails over to the secondary immediately (fired on error, not after the delay)", async () => {
    global.fetch = hedgeFetch({
      primary: () => Promise.reject(new Error("ECONNREFUSED")),
      secondary: () => Promise.resolve(genResponse(1, false)),
    });

    const loader = new Loader(loaderParams());
    const drained = [];
    const started = Date.now();
    await loader.loadHedged((r) => drained.push(r));

    expect(global.fetch.secondaryCalls()).toHaveLength(1);
    expect(drained).toHaveLength(1);
    expect(drained[0].payload.evaluations.feature.value.value).toBe(false);
    // Fired on the primary error, NOT after idling out the 40ms hedge delay.
    expect(Date.now() - started).toBeLessThan(40);
  });

  test("a slow-but-alive primary is hedged, and a late primary win heals forward over the stale secondary", async () => {
    const primaryDef = makeDeferred();
    global.fetch = hedgeFetch({
      primary: () => primaryDef.promise, // resolved manually AFTER the secondary
      secondary: () => Promise.resolve(genResponse(1, false)),
    });

    const loader = new Loader(loaderParams());
    const drained = [];
    // Resolves once the FIRST leg succeeds — the secondary, fired by the hedge
    // timer (~40ms) while the primary is still pending.
    await loader.loadHedged((r) => drained.push(r));

    expect(drained).toHaveLength(1);
    expect(drained[0].payload.meta.generation).toBe(1); // secondary painted first
    expect(global.fetch.secondaryCalls()).toHaveLength(1);

    // The slow primary now answers with a NEWER generation. It must still drain
    // through onResult so the caller's guard can heal forward — not be dropped
    // because the secondary already arrived.
    primaryDef.resolve(genResponse(42, true));
    await sleep(10);

    expect(drained.map((d) => d.payload.meta.generation)).toEqual([1, 42]);
  });

  test("when every leg fails, loadHedged rejects (so the caller can fall back / surface an error)", async () => {
    global.fetch = hedgeFetch({
      primary: () => Promise.reject(new Error("primary down")),
      secondary: () => Promise.reject(new Error("secondary down")),
    });

    const loader = new Loader(loaderParams());
    await expect(loader.loadHedged(() => {})).rejects.toThrow();
  });

  test("a single-URL loader still works (degenerate hedge: primary only, no secondary fired)", async () => {
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(7, true)),
      secondary: () => {
        throw new Error("no secondary configured");
      },
    });

    const loader = new Loader(loaderParams({ apiUrls: [PRIMARY] }));
    const result = await loader.load();
    expect(result.payload.meta.generation).toBe(7);
    expect(global.fetch.secondaryCalls()).toHaveLength(0);
  });
});

describe("hedge + guard integration: a slow primary never regresses an established client", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("established on primary gen 42; a hedge that paints the gen=1 secondary first does NOT flip the value, and the late primary heals forward", async () => {
    // Init: primary answers fast → secondary suppressed → established on gen 42.
    global.fetch = hedgeFetch({
      primary: () => Promise.resolve(genResponse(42, true)),
      secondary: () => {
        throw new Error("secondary must not fire during a fast init");
      },
    });

    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      apiUrls: [PRIMARY, SECONDARY],
      hedgeDelay: 40,
      timeout: 1000,
      collectEvaluationSummaries: false,
    });
    expect(q.get("feature")).toBe(true);
    expect(q.heldGeneration).toBe(42);

    // A refresh where the primary is slow and the depth-1 secondary (gen 1)
    // answers first. The reject-older guard must drop the secondary so the
    // established client keeps its gen-42 value — no flap.
    const primaryDef = makeDeferred();
    global.fetch = hedgeFetch({
      primary: () => primaryDef.promise,
      secondary: () => Promise.resolve(genResponse(1, false)),
    });

    await q.updateContext({ user: { key: "alice" } });
    expect(q.get("feature")).toBe(true); // gen 1 secondary REJECTED — no regression
    expect(q.heldGeneration).toBe(42);

    // Primary finally answers with a newer generation: heal forward.
    primaryDef.resolve(genResponse(43, false));
    await sleep(10);
    expect(q.get("feature")).toBe(false);
    expect(q.heldGeneration).toBe(43);
  });
});
