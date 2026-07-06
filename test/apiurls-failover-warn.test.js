/**
 * qfg-41nh.26 (WS5.3) — warn when an explicit `apiUrls` disables failover.
 *
 * The default (and every `domain` / `QUONFIG_DOMAIN`-derived) API-URL list
 * carries BOTH a primary and a secondary leg, and the SDK hedges/fails over
 * between them. An explicit `apiUrls` (or the singular `apiUrl` alias) replaces
 * that list wholesale, so a single-entry override silently drops the secondary
 * and disables automatic failover. init() logs a one-line WARN pointing the
 * caller at the fix (pass both a primary and a secondary URL). The default
 * two-leg list must NOT warn.
 */

const { Quonfig } = require("../dist/quonfig");

describe("init() warns when explicit apiUrls disables failover", () => {
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

  const failoverWarning = () =>
    warn.mock.calls.find((args) =>
      String(args[0]).includes("explicit apiUrls disables automatic failover")
    );

  test("(a) a single explicit apiUrls entry warns that failover is disabled", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts, apiUrls: ["https://primary.example.test"] });

    expect(failoverWarning()).toBeDefined();
  });

  test("(a') the singular apiUrl alias (one URL) also warns", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts, apiUrl: "https://primary.example.test" });

    expect(failoverWarning()).toBeDefined();
  });

  test("(b) two explicit apiUrls keep failover and must NOT warn", async () => {
    const q = new Quonfig();
    await q.init({
      ...baseOpts,
      apiUrls: ["https://primary.example.test", "https://secondary.example.test"],
    });

    expect(failoverWarning()).toBeUndefined();
  });

  test("(c) the default URL list carries both legs and must NOT warn", async () => {
    const q = new Quonfig();
    await q.init({ ...baseOpts });

    expect(failoverWarning()).toBeUndefined();
  });
});
