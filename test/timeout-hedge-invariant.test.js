/**
 * qfg-41nh.28 (WS5.4) — timeout > hedgeDelay invariant.
 *
 * The per-leg fetch `timeout` MUST stay above `hedgeDelay` (default 2000ms).
 * If a caller sets `timeout` at or below `hedgeDelay`, the primary leg is
 * aborted before the hedge timer can fire the secondary in parallel, so the
 * parallel hedge silently degrades to error-only sequential failover (the
 * secondary is contacted only AFTER the primary fully times out, never
 * concurrently with a still-alive-but-slow primary). init() warns so the
 * misconfiguration is visible instead of silent.
 */

const { Quonfig } = require("../dist/quonfig");

describe("init() timeout > hedgeDelay invariant", () => {
  let originalFetch;
  let warn;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ evaluations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warn.mockRestore();
  });

  const baseOpts = {
    sdkKey: "qf_pk_development_test",
    context: { user: { key: "alice" } },
    collectEvaluationSummaries: false,
  };

  const hedgeWarning = () => warn.mock.calls.find((args) => String(args[0]).includes("hedgeDelay"));

  test("warns when a provider-set timeout is below the default hedgeDelay", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts, timeout: 500 });

    const call = hedgeWarning();
    expect(call).toBeDefined();
    // The message names both effective values so the operator can act on it.
    expect(String(call[0])).toContain("500");
    expect(String(call[0])).toContain("2000");
  });

  test("warns when timeout equals hedgeDelay (no budget for a parallel hedge)", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts, timeout: 1500, hedgeDelay: 1500 });

    expect(hedgeWarning()).toBeDefined();
  });

  test("no warning with the default timeout (3000) and default hedgeDelay (2000)", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts });

    expect(hedgeWarning()).toBeUndefined();
  });

  test("no warning when timeout is safely above an explicit hedgeDelay", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts, timeout: 5000, hedgeDelay: 1000 });

    expect(hedgeWarning()).toBeUndefined();
  });
});
