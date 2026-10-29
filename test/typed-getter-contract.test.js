const { Quonfig } = require("../dist/quonfig");
const { captureConsole } = require("./helpers/captureConsole");

// Cross-SDK typed-getter contract (qfg-zvyy, JEFF'S DECISIONS 2026-10-22/23),
// ported from the integration-test-data v2026.10.23 matrix (tests/eval/
// {get,enabled}.yaml "Typed-getter contract" blocks, fixtures
// data/integration-tests/configs/getter.contract.*.json). The browser SDK does
// not run the generated ITD suite, so the matrix lives here and drives the
// PUBLIC client API: isEnabled, getDuration, get and getDetails.
//
// Each fixture is written as the evaluation api-delivery's eval-with-context
// sends a frontend key (ints and doubles as JSON numbers). The ENV_VAR
// fixtures (getter.contract.provided.*) are never sent to a frontend key
// (qfg-2agi.20), so on the browser they are a missing key. The malformed
// int/double rows are not something api-delivery emits today; the client
// must still treat them as failed reads rather than serve a string as a number.

const { STORED, KEY, loadedClient } = require("./helpers/getterContractMatrix");

const DEFAULT_DURATION = Object.freeze({ ms: 1234, seconds: 1.234 });

describe("typed-getter contract: isEnabled (enabled.yaml)", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  const cases = [
    ["bool", true],
    ["string", false],
    ["int", false],
    ["double", false],
    ["string_list", false],
    ["json", false],
    ["duration", false],
    ["string.true", false],
    ["string.false", false],
    ["int.malformed", false],
    ["double.malformed", false],
  ];

  test.each(cases)("isEnabled on stored %s returns %s", (name, expected) => {
    const q = loadedClient();
    expect(q.isEnabled(KEY(name))).toBe(expected);
  });

  test("isEnabled on a missing env var (omitted for frontend keys) returns false", () => {
    const q = loadedClient();
    expect(q.isEnabled(KEY("provided.bool.missing"))).toBe(false);
  });

  test("isEnabled on a json true is not a boolean flag", () => {
    const q = new Quonfig();
    q.setConfig({
      evaluations: { "json.true": { value: { type: "json", value: true }, configId: "j" } },
    });
    expect(q.isEnabled("json.true")).toBe(false);
  });

  test('isEnabled on a hydrated string "true" returns false (no string coercion)', () => {
    const q = new Quonfig();
    q.hydrate({ "flag.as.string": "true", "flag.bool": true });
    expect(q.isEnabled("flag.as.string")).toBe(false);
    expect(q.isEnabled("flag.bool")).toBe(true);
  });

  test("isEnabled logs once per key for a non-boolean value, never the raw value", () => {
    const q = loadedClient();
    q.isEnabled(KEY("string"));
    q.isEnabled(KEY("string"));
    q.isEnabled(KEY("string.true"));
    q.isEnabled(KEY("int.malformed"));
    q.isEnabled(KEY("int.malformed"));
    expect(logs.logCount("warn", /getter\.contract\.string"/)).toBe(1);
    expect(logs.logCount("warn", /getter\.contract\.string\.true/)).toBe(1);
    expect(logs.logCount("warn", /getter\.contract\.int\.malformed/)).toBe(1);
    expect(logs.logCount("warn", /fast|twelve/)).toBe(0);
  });

  test("isEnabled logs once per key for a missing key", () => {
    const q = loadedClient();
    q.isEnabled("no.such.flag");
    q.isEnabled("no.such.flag");
    expect(logs.logCount("warn", /no\.such\.flag/)).toBe(1);
  });

  test("isEnabled does not log for a resolved boolean", () => {
    const q = new Quonfig();
    q.setConfig({
      evaluations: {
        on: { value: { type: "bool", value: true } },
        off: { value: { type: "bool", value: false } },
      },
    });
    expect(q.isEnabled("on")).toBe(true);
    expect(q.isEnabled("off")).toBe(false);
    expect(logs.logCount("warn")).toBe(0);
  });

  test("isEnabled never throws, even with a throwing afterEvaluationCallback", () => {
    const q = loadedClient();
    q.afterEvaluationCallback = () => {
      throw new Error("boom");
    };
    expect(() => q.isEnabled(KEY("json"))).not.toThrow();
  });
});

describe("typed-getter contract: getDuration (get.yaml DURATION rows)", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  const mismatches = [
    "string",
    "int",
    "double",
    "bool",
    "string_list",
    "json",
    "string.duration",
    "int.malformed",
  ];

  test.each(mismatches)("DURATION getter on stored %s returns the default", (name) => {
    const q = loadedClient();
    expect(q.getDuration(KEY(name), DEFAULT_DURATION)).toEqual(DEFAULT_DURATION);
  });

  test.each(mismatches)(
    "DURATION getter on stored %s with no default returns undefined",
    (name) => {
      const q = loadedClient();
      expect(() => q.getDuration(KEY(name))).not.toThrow();
      expect(q.getDuration(KEY(name))).toBeUndefined();
    }
  );

  test("DURATION getter on stored duration returns it, ignoring the default", () => {
    const q = loadedClient();
    expect(q.getDuration(KEY("duration"), DEFAULT_DURATION)).toEqual({ ms: 30000, seconds: 30 });
    expect(q.getDuration(KEY("duration"))).toEqual({ ms: 30000, seconds: 30 });
  });

  test("DURATION getter on a missing key returns the default and does not log", () => {
    const q = loadedClient();
    expect(q.getDuration("no.such.duration", DEFAULT_DURATION)).toEqual(DEFAULT_DURATION);
    expect(q.getDuration("no.such.duration")).toBeUndefined();
    expect(logs.logCount("warn")).toBe(0);
  });

  test("DURATION getter before the client has loaded returns the default", () => {
    const q = new Quonfig();
    expect(q.getDuration("anything", DEFAULT_DURATION)).toEqual(DEFAULT_DURATION);
  });

  test("a wrong-type duration read logs once per key, never the raw value", () => {
    const q = loadedClient();
    q.getDuration(KEY("string.duration"), DEFAULT_DURATION);
    q.getDuration(KEY("string.duration"), DEFAULT_DURATION);
    q.getDuration(KEY("int"));
    expect(logs.logCount("warn", /getter\.contract\.string\.duration/)).toBe(1);
    expect(logs.logCount("warn", /getter\.contract\.int"/)).toBe(1);
    expect(logs.logCount("warn", /PT1S/)).toBe(0);
  });
});

describe("typed-getter contract: malformed stored values (qfg-zqoh)", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  const malformed = [
    ["int.malformed", "int"],
    ["double.malformed", "double"],
  ];

  test.each(malformed)("get on a malformed %s returns undefined (absent)", (name) => {
    const q = loadedClient();
    expect(q.get(KEY(name))).toBeUndefined();
  });

  test.each(malformed)(
    "getDetails on a malformed %s reports ERROR / PARSE_ERROR (qfg-wg1n)",
    (name) => {
      const q = loadedClient();
      const details = q.getDetails(KEY(name));
      expect(details.reason).toBe("ERROR");
      expect(details.errorCode).toBe("PARSE_ERROR");
      expect(details.value).toBeUndefined();
      expect(details.errorMessage).not.toMatch(/twelve|abc/);
    }
  );

  test.each([
    ["bool", "true"],
    ["int", 3.5],
    ["double", "3.9"],
    ["string", 3],
    ["string_list", "a,b"],
    ["string_list", ["a", 1]],
  ])("a %s value of the wrong JSON shape (%j) is a failed read", (type, value) => {
    const q = new Quonfig();
    q.setConfig({ evaluations: { k: { value: { type, value }, configId: "c" } } });
    expect(q.get("k")).toBeUndefined();
    expect(q.getDetails("k").errorCode).toBe("PARSE_ERROR");
  });

  test("a malformed read logs once per key, never the raw value", () => {
    const q = loadedClient();
    q.get(KEY("int.malformed"));
    q.get(KEY("int.malformed"));
    q.isEnabled(KEY("int.malformed"));
    expect(logs.logCount("warn", /getter\.contract\.int\.malformed/)).toBe(1);
    expect(logs.logCount("warn", /twelve/)).toBe(0);
  });

  test("well-formed values are unchanged by validation", () => {
    const q = loadedClient();
    expect(q.get(KEY("int"))).toBe(30);
    expect(q.get(KEY("double"))).toBe(3.9);
    expect(q.get(KEY("double.whole"))).toBe(3);
    expect(q.get(KEY("double.huge"))).toBe(1e300);
    expect(q.get(KEY("string.false"))).toBe("false");
    expect(q.get(KEY("string_list"))).toEqual(["a", "b"]);
    expect(q.get(KEY("json"))).toEqual({ a: 1 });
    expect(logs.logCount("warn")).toBe(0);
  });
});
