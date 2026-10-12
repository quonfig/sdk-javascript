/**
 * qfg-goi1.10.12 (#27): eval-summary counters are keyed per evaluated value,
 * not per (config key, config type). The aggregator keyed on
 * `${key},${configType}`, so after an updateContext moved a flag to another
 * rule/value, every later evaluation was counted under the FIRST value seen.
 * ITD tests/eval/telemetry.yaml pins separate counters; sdk-go keys on
 * config id + rule index + weighted value index + selected value.
 */

const { Quonfig } = require("../dist/quonfig");

const flagAt = (value, conditionalValueIndex, reason) => ({
  evaluations: {
    "my-flag": {
      value: { type: "bool", value },
      configId: "cfg-1",
      configType: "FEATURE_FLAG",
      configRowIndex: 0,
      conditionalValueIndex,
      reason,
    },
  },
});

describe("eval-summary counter key", () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = [];
    global.fetch = jest.fn((url, options) => {
      calls.push({ url, options });
      const body = url.includes("/api/v1/telemetry/") ? {} : { evaluations: {} };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("different values of one flag get separate counters in one summary", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    q.setConfig(flagAt(true, 1, "TARGETING_MATCH"));
    q.get("my-flag");
    q.get("my-flag");
    q.setConfig(flagAt(false, 0, "DEFAULT"));
    q.get("my-flag");
    await q.close();

    const telemetryCall = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).pop();
    const summaries = JSON.parse(telemetryCall.options.body).events[0].summaries.summaries;

    expect(summaries).toHaveLength(1);
    expect(summaries[0].key).toBe("my-flag");
    expect(summaries[0].type).toBe("FEATURE_FLAG");
    const counters = summaries[0].counters
      .map((c) => ({ value: c.selectedValue.bool, cvi: c.conditionalValueIndex, count: c.count }))
      .sort((a, b) => a.cvi - b.cvi);
    expect(counters).toEqual([
      { value: false, cvi: 0, count: 1 },
      { value: true, cvi: 1, count: 2 },
    ]);
  });
});
