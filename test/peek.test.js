/**
 * qfg-6vno.10: peek(key) is a non-recording read for bindings (sdk-react's
 * useSyncExternalStore getSnapshot). It returns the same value as get() but
 * records no evaluation summary and never fires afterEvaluationCallback.
 */

const { Quonfig } = require("../dist/quonfig");

const payload = {
  evaluations: {
    "my-flag": {
      value: { type: "bool", value: true },
      configId: "cfg-flag",
      configType: "FEATURE_FLAG",
      configRowIndex: 0,
      conditionalValueIndex: 0,
      reason: "STATIC",
    },
  },
};

describe("peek (qfg-6vno.10)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(url.includes("/api/v1/telemetry/") ? {} : { evaluations: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const client = async (afterEvaluationCallback) => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries: true,
      afterEvaluationCallback,
      apiUrl: "https://primary.quonfig-staging.com",
    });
    q.setConfig(payload);
    return q;
  };

  const flushTimers = () => new Promise((r) => setTimeout(r, 5));

  test("peek returns the value without recording or firing the callback", async () => {
    const cb = jest.fn();
    const q = await client(cb);
    const record = jest.spyOn(q.evaluationSummaryAggregator, "record");

    for (let i = 0; i < 5; i++) expect(q.peek("my-flag")).toBe(true);
    expect(q.peek("missing")).toBeUndefined();
    await flushTimers();

    expect(record).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    await q.close();
  });

  test("get still records and fires the callback once per read", async () => {
    const cb = jest.fn();
    const q = await client(cb);
    const record = jest.spyOn(q.evaluationSummaryAggregator, "record");

    expect(q.get("my-flag")).toBe(true);
    await flushTimers();

    expect(record).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("my-flag", true, expect.anything());
    await q.close();
  });

  test("peek before load returns undefined without warning", async () => {
    const q = new Quonfig();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(q.peek("my-flag")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
