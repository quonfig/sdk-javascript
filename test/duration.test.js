const { Quonfig } = require("../dist/quonfig");
const { Config } = require("../dist/config");
const { massageSelectedValue } = require("../dist/telemetry/evaluationSummaryAggregator");
const { loadDurationGrammar } = require("./helpers/durationGrammarFixture");
const { captureConsole } = require("./helpers/captureConsole");

// Duration parsing against the shared grammar fixture in integration-test-data
// (tests/duration/grammar.yaml). sdk-javascript reads server-evaluated values
// and has no generated integration suite, so it consumes the fixture directly
// (qfg-2agi.14, the principle-4 exception).

const fixture = loadDurationGrammar();

const durationEval = (value) => ({
  value: { type: "duration", value },
  configId: "cfg-dur",
  configType: "config",
  valueType: "duration",
  reason: "STATIC",
});

const clientWith = (evaluations) => {
  const q = new Quonfig();
  q.setConfig({ evaluations });
  return q;
};

describe("duration grammar fixture: valid values", () => {
  test.each(fixture.valid.map((v) => [v.value, v.millis]))("%j = %d ms", (value, millis) => {
    const q = clientWith({ "my.duration": durationEval(value) });
    expect(q.getDuration("my.duration")).toEqual({ ms: millis, seconds: millis / 1000 });
  });
});

describe("duration grammar fixture: invalid values", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  test.each(fixture.invalid.map((v) => [v]))("%j is rejected", (value) => {
    const q = clientWith({ "my.duration": durationEval(value) });
    expect(q.getDuration("my.duration")).toBeUndefined();
    expect(q.get("my.duration")).toBeUndefined();
  });
});

describe("malformed duration contract", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  test("a provided (ENV_VAR) object returns undefined instead of throwing or 0", () => {
    const q = clientWith({
      "env.duration": durationEval({ provided: { source: "ENV_VAR", lookup: "MY_DURATION" } }),
    });
    expect(q.getDuration("env.duration")).toBeUndefined();
  });

  test("the dead {definition, millis} shape is not trusted", () => {
    const q = clientWith({ "obj.duration": durationEval({ definition: "PT1S", millis: 1000 }) });
    expect(q.getDuration("obj.duration")).toBeUndefined();
  });

  test("warns once per key, without the raw value", () => {
    const q = clientWith({
      "bad.one": durationEval("5m"),
      "bad.two": durationEval("garbage-secret"),
    });
    q.getDuration("bad.one");
    q.getDuration("bad.one");
    q.getDuration("bad.two");
    expect(logs.logCount("warn", /bad\.one/)).toBe(1);
    expect(logs.logCount("warn", /bad\.two/)).toBe(1);
    expect(logs.logCount("warn", /garbage-secret/)).toBe(0);
  });

  test("getDetails reports reason ERROR with the default (undefined) value", () => {
    const q = clientWith({ "bad.duration": durationEval("P1W") });
    const details = q.getDetails("bad.duration");
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("TYPE_MISMATCH");
    expect(details.value).toBeUndefined();
  });

  test("telemetry never carries the raw malformed string", () => {
    const configs = Config.digest({ evaluations: { "bad.duration": durationEval("secret-ish") } });
    expect(JSON.stringify(massageSelectedValue(configs["bad.duration"]) ?? null)).not.toContain(
      "secret-ish"
    );
  });

  test("telemetry still reports a valid duration's ISO string", () => {
    const configs = Config.digest({ evaluations: { "ok.duration": durationEval("PT30S") } });
    expect(massageSelectedValue(configs["ok.duration"])).toBe("PT30S");
  });
});

describe("hydrate() typing", () => {
  test("types each value by its shape", () => {
    const q = new Quonfig();
    q.hydrate({
      b: true,
      i: 3,
      d: 1.5,
      s: "hello",
      dur: { ms: 1500, seconds: 1.5 },
      list: ["a", "b"],
      json: { a: 1 },
    });
    const types = Object.fromEntries(Object.entries(q.configs).map(([k, c]) => [k, c.type]));
    expect(types).toEqual({
      b: "bool",
      i: "int",
      d: "double",
      s: "string",
      dur: "duration",
      list: "string_list",
      json: "json",
    });
    expect(q.getDuration("dur")).toEqual({ ms: 1500, seconds: 1.5 });
  });

  test("round-trips extract() output for durations", () => {
    const source = clientWith({ "my.duration": durationEval("P1DT6H2M1.5S") });
    const q = new Quonfig();
    q.hydrate(source.extract());
    expect(q.configs["my.duration"].type).toBe("duration");
    expect(q.getDuration("my.duration")).toEqual({ ms: 108121500, seconds: 108121.5 });
  });
});
