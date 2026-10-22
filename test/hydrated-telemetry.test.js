/**
 * qfg-27wr: reads of hydrated values (hydrate() seeds Configs with no
 * evaluation metadata) are held and recorded against the first network Config
 * installed for that key, with its real metadata, when the values match. A
 * mismatch, or no network Config ever arriving, drops them. Reads made before
 * init() wires telemetry are buffered and recorded once it does.
 */

const { Quonfig } = require("../dist/quonfig");
const { telemetryFetch } = require("./helpers/telemetryFetch");

const payloadFor = (value) => ({
  evaluations: {
    g: {
      value: { type: "string", value },
      configId: "cfg-g",
      configType: "FEATURE_FLAG",
      configRowIndex: 1,
      conditionalValueIndex: 2,
      reason: "TARGETING_MATCH",
    },
  },
});

const summaries = (tf) => {
  const out = [];
  for (let i = 0; i < tf.postCount(); i++) {
    JSON.parse(tf.body(i)).events.forEach((e) => out.push(...e.summaries.summaries));
  }
  return out;
};

const flushTimers = () => new Promise((r) => setTimeout(r, 5));

describe("hydrated reads are reported once the network config lands (qfg-27wr)", () => {
  let originalFetch;
  let tf;

  beforeEach(() => {
    originalFetch = global.fetch;
    tf = telemetryFetch();
    global.fetch = tf.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const initOpts = (extra = {}) => ({
    sdkKey: "qf_pk_development_test",
    context: { user: { key: "alice" } },
    collectEvaluationSummaries: true,
    apiUrl: "https://primary.quonfig-staging.com",
    ...extra,
  });

  test("(a) matching network value: hydrated reads count with its metadata", async () => {
    const q = new Quonfig();
    await q.init(initOpts());
    q.hydrate({ g: "seed" });
    expect(q.get("g")).toBe("seed");
    expect(q.get("g")).toBe("seed");
    q.setConfig(payloadFor("seed"));
    await q.close();

    const g = summaries(tf).filter((s) => s.key === "g");
    expect(g).toHaveLength(1);
    expect(g[0].type).toBe("FEATURE_FLAG");
    expect(g[0].counters).toHaveLength(1);
    expect(g[0].counters[0]).toMatchObject({
      configId: "cfg-g",
      configRowIndex: 1,
      conditionalValueIndex: 2,
      selectedValue: { string: "seed" },
      count: 2,
    });
  });

  test("(b) differing network value: hydrated reads are dropped", async () => {
    const q = new Quonfig();
    await q.init(initOpts());
    q.hydrate({ g: "seed" });
    q.get("g");
    q.get("g");
    q.setConfig(payloadFor("other"));
    await q.close();

    expect(summaries(tf).filter((s) => s.key === "g")).toHaveLength(0);
  });

  test("(c) close() before any network config: nothing reported, no error", async () => {
    const q = new Quonfig();
    await q.init(initOpts());
    q.hydrate({ g: "seed" });
    q.get("g");
    await expect(q.close()).resolves.toBeUndefined();

    expect(summaries(tf).filter((s) => s.key === "g")).toHaveLength(0);
  });

  test("key absent from the next network install: hydrated reads are dropped", async () => {
    const q = new Quonfig();
    await q.init(initOpts());
    q.hydrate({ g: "seed" });
    q.get("g");
    q.setConfig({ evaluations: {} });
    q.setConfig(payloadFor("seed"));
    await q.close();

    expect(summaries(tf).filter((s) => s.key === "g")).toHaveLength(0);
  });

  test("(d) setConfig()+get() before init(): recorded once after init, callback fires", async () => {
    const q = new Quonfig();
    q.setConfig(payloadFor("seed"));
    expect(q.get("g")).toBe("seed");

    const cb = jest.fn();
    await q.init(initOpts({ afterEvaluationCallback: cb }));
    await flushTimers();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("g", "seed", { user: { key: "alice" } });
    await q.close();

    const g = summaries(tf).filter((s) => s.key === "g");
    expect(g).toHaveLength(1);
    expect(g[0].counters[0]).toMatchObject({ configId: "cfg-g", count: 1 });
  });

  test("hydrate()+get() before init(), init's network config matches: counted once", async () => {
    // init()'s own eval fetch delivers g = "seed" (the SSR-then-hydrate shape).
    global.fetch = jest.fn((url, options) =>
      url.includes("/api/v1/telemetry/")
        ? tf.fetch(url, options)
        : Promise.resolve(
            new Response(JSON.stringify(payloadFor("seed")), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          )
    );
    const q = new Quonfig();
    q.hydrate({ g: "seed" });
    q.get("g");
    await q.init(initOpts());
    await q.close();

    const g = summaries(tf).filter((s) => s.key === "g");
    expect(g).toHaveLength(1);
    expect(g[0].counters[0]).toMatchObject({ configId: "cfg-g", count: 1 });
  });

  test("peek() of a hydrated value still records nothing", async () => {
    const q = new Quonfig();
    await q.init(initOpts());
    q.hydrate({ g: "seed" });
    q.peek("g");
    q.setConfig(payloadFor("seed"));
    await q.close();

    expect(summaries(tf).filter((s) => s.key === "g")).toHaveLength(0);
  });
});
