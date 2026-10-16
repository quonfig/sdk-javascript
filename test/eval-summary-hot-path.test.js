/**
 * qfg-23uf: the per-value eval-summary counter key (qfg-goi1.10.12) must not
 * serialize the selected value on every get(). 1.5.0 JSON.stringify'd the
 * whole counter per read, so a 60KB JSON config cost ~212us per get() against
 * ~0.14us with summaries off. The counter identity is now computed once per
 * installed Config.
 */

const { Quonfig } = require("../dist/quonfig");

const bigJson = () => {
  const items = [];
  for (let i = 0; i < 600; i++) {
    items.push({ id: i, name: `item-${i}`, tags: ["alpha", "beta", "gamma"], weight: i * 1.5 });
  }
  return { items };
};

const payload = (value) => ({
  evaluations: {
    "big-config": {
      value: { type: "json", value },
      configId: "cfg-big",
      configType: "CONFIG",
      configRowIndex: 0,
      conditionalValueIndex: 0,
      reason: "STATIC",
    },
  },
});

describe("eval-summary hot path (qfg-23uf)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(url.includes("/api/v1/telemetry/") ? {} : { evaluations: {} }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const client = async (collectEvaluationSummaries) => {
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      collectEvaluationSummaries,
      apiUrl: "https://primary.quonfig-staging.com",
    });
    q.setConfig(payload(bigJson()));
    return q;
  };

  test("the selected value is not serialized on every get()", async () => {
    const value = bigJson();
    expect(JSON.stringify(value).length).toBeGreaterThan(40000);

    const q = await client(true);
    const spy = jest.spyOn(JSON, "stringify");
    for (let i = 0; i < 1000; i++) q.get("big-config");
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    await q.close();

    expect(calls).toBeLessThanOrEqual(1);
  });

  test("per-read cost with summaries on stays near the summaries-off path", async () => {
    const reads = 2000;
    const time = (q) => {
      for (let i = 0; i < 200; i++) q.get("big-config"); // warm up
      const start = process.hrtime.bigint();
      for (let i = 0; i < reads; i++) q.get("big-config");
      return Number(process.hrtime.bigint() - start);
    };

    const off = await client(false);
    const offNs = time(off);
    await off.close();

    const on = await client(true);
    const onNs = time(on);
    await on.close();

    // 1.5.0 measured ~1500x. A loose bound keeps this stable on noisy CI.
    expect(onNs).toBeLessThan(Math.max(offNs, 1e6) * 20);
  });

  test("a reinstall with the same value keeps counting under one counter", async () => {
    const calls = [];
    global.fetch = jest.fn((url, options) => {
      calls.push({ url, options });
      return Promise.resolve(
        new Response(
          JSON.stringify(url.includes("/api/v1/telemetry/") ? {} : { evaluations: {} }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    });

    const q = await client(true);
    q.get("big-config");
    q.setConfig(payload(bigJson()));
    q.get("big-config");
    q.get("big-config");
    await q.close();

    const telemetryCall = calls.filter((c) => c.url.includes("/api/v1/telemetry/")).pop();
    const summaries = JSON.parse(telemetryCall.options.body).events[0].summaries.summaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].counters).toHaveLength(1);
    expect(summaries[0].counters[0].count).toBe(3);
  });
});
