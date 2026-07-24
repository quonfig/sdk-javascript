/**
 * qfg-h8xn: eval-summary counters must carry the canonical int reason wire
 * code (matching sdk-node's computeReason: 1=STATIC 2=TARGETING_MATCH
 * 3=SPLIT), never the eval-context string form. Since api-delivery started
 * emitting `reason` on the wire (2026-06-29), the SDK echoed the string
 * ("TARGETING_MATCH") into counters and api-telemetry's z.number() schema
 * rejected the entire envelope — a total browser-telemetry blackout for
 * workspaces with rule-matched evals.
 */

const { Quonfig } = require("../dist/quonfig");

function makeFetchMock() {
  const calls = [];
  const fetchMock = jest.fn((url, options) => {
    calls.push({ url, options });
    if (typeof url === "string" && url.includes("/api/v1/telemetry/")) {
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ evaluations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  return { fetchMock, calls };
}

describe("summary counters carry int reason wire codes (qfg-h8xn)", () => {
  let originalFetch;
  let fetchMock;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    ({ fetchMock, calls } = makeFetchMock());
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("string reasons from the eval wire are mapped to ints; absent reason stays absent", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    q.setConfig({
      evaluations: {
        "targeted-flag": {
          value: { type: "bool", value: true },
          configId: "cfg-1",
          configType: "FEATURE_FLAG",
          configRowIndex: 0,
          conditionalValueIndex: 0,
          reason: "TARGETING_MATCH",
          ruleIndex: 1,
        },
        "split-flag": {
          value: { type: "bool", value: false },
          configId: "cfg-2",
          configType: "FEATURE_FLAG",
          configRowIndex: 0,
          conditionalValueIndex: 0,
          reason: "SPLIT",
          weightedValueIndex: 1,
        },
        "plain-flag": {
          value: { type: "bool", value: true },
          configId: "cfg-3",
          configType: "FEATURE_FLAG",
          configRowIndex: 0,
          conditionalValueIndex: 0,
        },
      },
    });

    q.get("targeted-flag");
    q.get("split-flag");
    q.get("plain-flag");
    await q.close();

    const telemetryCall = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).pop();
    expect(telemetryCall).toBeDefined();
    const body = JSON.parse(telemetryCall.options.body);
    const summaries = body.events[0].summaries.summaries;

    const counterFor = (key) => summaries.find((s) => s.key === key).counters[0];

    expect(counterFor("targeted-flag").reason).toBe(2);
    expect(counterFor("split-flag").reason).toBe(3);
    expect(counterFor("plain-flag")).not.toHaveProperty("reason");
  });
});
