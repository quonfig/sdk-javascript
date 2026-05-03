/**
 * qfg-q3cx: `close()` must drain in-memory telemetry counters before tearing
 * down timers, and `flush()` must be a public method so SPAs can drain
 * explicitly without a full close.
 *
 * Mirrors the sdk-node `flush()`/`close()` contract (qfg-wro). Go/Ruby/Python
 * SDKs all drain on close; sdk-javascript previously did not, and unlike Node
 * had no public `flush()` escape hatch.
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
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ evaluations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return { fetchMock, calls };
}

describe("close()/flush() drain telemetry (qfg-q3cx)", () => {
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

  test("close() POSTs queued evaluation summaries before resolving", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      collectLoggerNames: false,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    const aggregator = q.evaluationSummaryAggregator;
    expect(aggregator).toBeDefined();
    aggregator.data.set("test-flag,bool", {
      configRowIndex: 0,
      conditionalValueIndex: 0,
      weightedValueIndex: undefined,
      selectedValue: { bool: true },
      configEvaluationCounter: undefined,
      count: 1,
    });
    expect(aggregator.data.size).toBe(1);

    const beforeCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;

    await q.close();

    const afterCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;
    expect(afterCount).toBe(beforeCount + 1);
    expect(aggregator.data.size).toBe(0);
  });

  test("flush() drains without tearing down the SDK", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      collectLoggerNames: false,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    expect(typeof q.flush).toBe("function");

    const aggregator = q.evaluationSummaryAggregator;
    aggregator.data.set("test-flag,bool", {
      configRowIndex: 0,
      conditionalValueIndex: 0,
      weightedValueIndex: undefined,
      selectedValue: { bool: true },
      configEvaluationCounter: undefined,
      count: 3,
    });

    const beforeCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;

    await q.flush();

    const afterCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;
    expect(afterCount).toBe(beforeCount + 1);
    expect(aggregator.data.size).toBe(0);

    // SDK still alive — flush() must not stop timers
    expect(q.evaluationSummaryAggregator).toBeDefined();

    await q.close();
  });

  // qfg-5jcd: get() previously deferred record() via setTimeout(0). A tight
  // sync loop of get() followed immediately by await close() would race past
  // the records — close() flushed an empty aggregator and posted nothing.
  // The fix records synchronously inside get() so records land before any
  // await boundary in close().
  test("close() POSTs records made during sync get() loop with no microtask yield (qfg-5jcd)", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      collectLoggerNames: false,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    // Seed a real config so get() finds it and records via the production
    // setTimeout/record path (not the manual aggregator.data.set used in the
    // qfg-q3cx tests above, which bypasses the race we want to catch).
    q.setConfig({
      evaluations: {
        "test-flag": {
          value: { type: "bool", value: true },
          configId: "cfg-1",
          configType: "CONFIG",
          configRowIndex: 0,
          conditionalValueIndex: 0,
        },
      },
    });

    const beforeCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;

    // Tight sync loop — no microtask yield between the get() calls and close().
    for (let i = 0; i < 6; i++) {
      q.get("test-flag");
    }
    await q.close();

    const afterCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;
    expect(afterCount).toBe(beforeCount + 1);

    const telemetryCall = calls
      .filter((c) => c.url.includes("/api/v1/telemetry/"))
      .pop();
    const body = JSON.parse(telemetryCall.options.body);
    const summary = body.events[0].summaries.summaries[0];
    expect(summary.key).toBe("test-flag");
    expect(summary.counters[0].count).toBe(6);
  });

  test("close() with empty aggregator resolves without POSTing", async () => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      collectLoggerNames: false,
      apiUrl: "https://primary.quonfig-staging.com",
    });

    const beforeCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;

    await q.close();

    const afterCount = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).length;
    expect(afterCount).toBe(beforeCount);
  });
});
