/**
 * qfg-cyuk: `init({apiUrl: ...})` (singular) was silently dropped, leaving the
 * SDK to fall back to DEFAULT_API_URLS (prod). Mirrors the singular→plural
 * normalization @quonfig/react already does in its provider.
 */

const { Quonfig } = require("../dist/quonfig");

describe("init() apiUrl singular alias", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Return a minimal valid EvaluationPayload so init().load() resolves.
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ evaluations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("apiUrl (singular) is normalized to apiUrls = [apiUrl]", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    expect(q.loader.apiUrls).toEqual(["https://primary.quonfig-staging.com"]);
  });

  test("apiUrls (plural) wins when both are provided", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
      apiUrls: ["https://primary.quonfig-staging.com"],
      apiUrl: "https://should-be-ignored.example.com",
    });

    expect(q.loader.apiUrls).toEqual(["https://primary.quonfig-staging.com"]);
  });

  test("neither apiUrl nor apiUrls falls back to defaults (prod)", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: false,
    });

    expect(q.loader.apiUrls).toEqual([
      "https://primary.quonfig.com",
      "https://secondary.quonfig.com",
    ]);
  });
});
