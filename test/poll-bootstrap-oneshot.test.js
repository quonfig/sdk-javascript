/**
 * qfg-xqxi: bootstrap is a ONE-SHOT init seed, not a value re-applied on every
 * poll tick.
 *
 * Bootstrap (globalThis._quonfigBootstrap) exists to paint instantly at init()
 * from an SSR snapshot, skipping the first network round-trip. The bug: the
 * bootstrap check lived in the private load() that BOTH init() and the polling
 * loop share, and nothing ever cleared the snapshot. So after the first live
 * poll fetch showed fresh data, the very next tick re-applied the STALE SSR
 * snapshot and short-circuited (no fetch) forever — a permanent revert to
 * SSR-time values, making server-side flag flips invisible.
 *
 * Fix: honor bootstrap only on the first load() (init's paint). Every later
 * load() (the poll ticks) ignores it and fetches live.
 */

const { Quonfig } = require("../dist/quonfig");

const okBody = (value) =>
  new Response(JSON.stringify({ evaluations: { feature: { value: { type: "bool", value } } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const CONTEXT = { user: { key: "alice" } };

describe("bootstrap one-shot seed (qfg-xqxi)", () => {
  let originalFetch;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete globalThis._quonfigBootstrap;
  });

  test("init paints from bootstrap with zero network; polling then owns live state and never reverts", async () => {
    // SSR injected a snapshot for THIS exact context: feature=false (stale).
    globalThis._quonfigBootstrap = {
      context: CONTEXT,
      evaluations: { feature: { value: { type: "bool", value: false } } },
    };

    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      return okBody(true); // every server fetch reports the LIVE value: true
    });

    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: CONTEXT,
      apiUrls: ["https://primary.quonfig-staging.com"],
      collectEvaluationSummaries: false,
    });

    // init() painted instantly from bootstrap — no network, stale value.
    expect(call).toBe(0);
    expect(q.get("feature")).toBe(false);

    // First poll fetch hits the network and shows fresh live data.
    await q.poll({ frequencyInMs: 1000 });
    expect(call).toBe(1);
    expect(q.get("feature")).toBe(true);

    // THE REGRESSION ASSERTION: tick 2 must perform a REAL fetch and keep the
    // live value. Pre-fix, this.load() saw the bootstrap still on globalThis,
    // re-applied the stale snapshot (feature=false) and skipped the network.
    await jest.advanceTimersByTimeAsync(1000);
    expect(call).toBe(2);
    expect(q.get("feature")).toBe(true);

    // And it stays live on every subsequent tick.
    await jest.advanceTimersByTimeAsync(1000);
    expect(call).toBe(3);
    expect(q.get("feature")).toBe(true);

    q.stopPolling();
  });
});
