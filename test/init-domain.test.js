/**
 * qfg-ppuc.1: `init({domain: ...})` is the documented browser path for flipping
 * api + telemetry URLs in lockstep. Resolution order (highest wins):
 *   1. explicit `apiUrls` / `telemetryUrl` opts
 *   2. `domain` init option
 *   3. `process.env.QUONFIG_DOMAIN`
 *   4. hardcoded `quonfig.com`
 */

const { Quonfig } = require("../dist/quonfig");

describe("init() domain option", () => {
  let originalFetch;
  const ORIGINAL_DOMAIN = process.env.QUONFIG_DOMAIN;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ evaluations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (ORIGINAL_DOMAIN === undefined) {
      delete process.env.QUONFIG_DOMAIN;
    } else {
      process.env.QUONFIG_DOMAIN = ORIGINAL_DOMAIN;
    }
  });

  test("domain derives api + telemetry URLs in lockstep", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      domain: "quonfig-staging.com",
    });

    expect(q.loader.apiUrls).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
    expect(q._telemetryUploader.telemetryUrl).toBe("https://telemetry.quonfig-staging.com");
  });

  test("domain wins over process.env.QUONFIG_DOMAIN", async () => {
    process.env.QUONFIG_DOMAIN = "should-be-ignored.example";
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      domain: "quonfig-staging.com",
    });

    expect(q.loader.apiUrls).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
    expect(q._telemetryUploader.telemetryUrl).toBe("https://telemetry.quonfig-staging.com");
  });

  test("explicit apiUrls + telemetryUrl override domain", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      domain: "quonfig-staging.com",
      apiUrls: ["https://api.example.com"],
      telemetryUrl: "https://telemetry.example.com",
    });

    expect(q.loader.apiUrls).toEqual(["https://api.example.com"]);
    expect(q._telemetryUploader.telemetryUrl).toBe("https://telemetry.example.com");
  });

  test("localhost domain still derives subdomains (no special-casing)", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      domain: "quonfig.localhost",
    });

    expect(q.loader.apiUrls).toEqual([
      "https://primary.quonfig.localhost",
      "https://secondary.quonfig.localhost",
    ]);
    expect(q._telemetryUploader.telemetryUrl).toBe("https://telemetry.quonfig.localhost");
  });
});
