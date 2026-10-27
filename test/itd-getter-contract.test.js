const fs = require("fs");
const path = require("path");
const { STORED, loadedClient } = require("./helpers/getterContractMatrix");
const { captureConsole } = require("./helpers/captureConsole");

// Drift guard for the typed-getter contract (qfg-zvyy.9).
//
// sdk-javascript does not run the generated integration-test-data suite, so
// test/typed-getter-contract.test.js carries a hand-ported copy of the
// getter.contract matrix. This file keeps that copy honest: it reads the
// fixtures and the YAML cases from the sibling integration-test-data checkout
// (pinned in .github/workflows/test.yaml) and
//
//   1. fails if a getter.contract fixture was added, removed or changed and
//      helpers/getterContractMatrix.js was not updated to match;
//   2. RUNS every enabled.yaml row and every get.yaml DURATION row on a
//      getter.contract key through the public isEnabled / getDuration;
//   3. classifies every other getter.contract row (typed getters and
//      get_or_raise variants this SDK does not have, and ENV_VAR rows that a
//      frontend key never receives) and fails on any row it cannot classify,
//      so a new function or type in the ITD matrix is a red build here.
//
// The YAML is read with a tiny line reader rather than a YAML dependency.
// Unrecognized expected/default shapes on a row that is RUN throw, so a
// format change fails loudly instead of silently skipping cases.

const ITD = path.resolve(__dirname, "../../integration-test-data");
const CONFIGS = path.join(ITD, "data/integration-tests/configs");
const EVAL = path.join(ITD, "tests/eval");
const PREFIX = "getter.contract.";

// Typed getters the server SDKs have and this SDK does not (scope of
// qfg-zvyy.9: getDuration and isEnabled only). Listed explicitly so a new type
// in the matrix is a failure here, not a silent skip.
const NO_JS_TYPED_GETTER = ["STRING", "INT", "DOUBLE", "BOOLEAN", "STRING_LIST", "JSON"];

const scalar = (raw) => {
  const s = raw.trim();
  if (s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^"/.test(s)) return JSON.parse(s);
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  throw new Error(`unrecognized scalar: ${raw}`);
};

// The wire form api-delivery's eval-with-context uses for a stored value:
// numeric strings in int/double fixtures go out as JSON numbers; malformed
// ones ("twelve", "abc") stay strings.
const wireValue = ({ type, value }) => {
  if ((type === "int" || type === "double") && typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
};

const readFixtures = () =>
  fs
    .readdirSync(CONFIGS)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CONFIGS, f), "utf8")));

// Splits a tests/eval/*.yaml file into case blocks (one per `- name:` line)
// and returns the getter.contract ones with the fields this guard needs.
const readCases = (file) => {
  const lines = fs.readFileSync(path.join(EVAL, file), "utf8").split("\n");
  const blocks = [];
  let current = null;
  lines.forEach((line, i) => {
    const start = /^\s*- name:\s*(.*)$/.exec(line);
    if (start) {
      current = { file, line: i + 1, name: start[1].trim(), lines: [] };
      blocks.push(current);
      return;
    }
    if (current) current.lines.push(line);
  });

  return blocks
    .map((b) => {
      const field = (re) => {
        for (const l of b.lines) {
          const m = re.exec(l);
          if (m) return m[1];
        }
        return undefined;
      };
      const key = field(/^\s+key:\s*"([^"]*)"/);
      if (!key || !key.startsWith(PREFIX)) return null;
      const expectedAt = b.lines.findIndex((l) => /^\s+expected:\s*$/.test(l));
      const expected = {};
      if (expectedAt >= 0) {
        for (const l of b.lines.slice(expectedAt + 1)) {
          const m = /^\s+(value|millis):\s*(.*)$/.exec(l);
          if (!m) break;
          expected[m[1]] = m[2];
        }
      }
      return {
        where: `${b.file}:${b.line} "${b.name}"`,
        fn: field(/^\s+function:\s*(\S+)/),
        type: field(/^\s+type:\s*(\S+)/),
        key,
        name: key.slice(PREFIX.length),
        defaultRaw: field(/^\s+default:\s*(.*)$/),
        expected,
        envVars: b.lines.some((l) => /^\s+env_vars:\s*$/.test(l)),
      };
    })
    .filter(Boolean);
};

const itdPresent = fs.existsSync(CONFIGS) && fs.existsSync(EVAL);

const describeItd = itdPresent ? describe : describe.skip;

if (!itdPresent && process.env.CI) {
  throw new Error(`integration-test-data not found at ${ITD}; CI must check it out as a sibling`);
}

describeItd("ITD getter.contract fixtures match the ported matrix", () => {
  test("every non-ENV_VAR fixture is in helpers/getterContractMatrix.js with the same value", () => {
    const fromItd = {};
    readFixtures().forEach((cfg) => {
      const name = cfg.key.slice(PREFIX.length);
      const value = cfg.default.rules[0].value;
      if (value.type === "provided") return;
      fromItd[name] = { type: value.type, value: wireValue(value) };
    });
    expect(Object.keys(fromItd).length).toBeGreaterThan(0);
    expect(STORED).toEqual(fromItd);
  });
});

describeItd("ITD getter.contract YAML rows drive the public client", () => {
  let logs;
  beforeEach(() => {
    logs = captureConsole();
  });
  afterEach(() => logs.restore());

  const rows = itdPresent
    ? [...readCases("get.yaml"), ...readCases("get_or_raise.yaml"), ...readCases("enabled.yaml")]
    : [];

  const classify = (row) => {
    if (row.envVars || row.name.startsWith("provided.")) return "server-only";
    if (!(row.name in STORED)) return "unknown";
    if (row.fn === "enabled") return "run-enabled";
    if (row.fn === "get" && row.type === "DURATION") return "run-duration";
    if (row.fn === "get" && NO_JS_TYPED_GETTER.includes(row.type)) return "no-js-surface";
    if (row.fn === "get_or_raise") return "no-js-surface";
    return "unknown";
  };

  const runEnabled = rows.filter((r) => classify(r) === "run-enabled");
  const runDuration = rows.filter((r) => classify(r) === "run-duration");

  test("every getter.contract row is classified", () => {
    const unknown = rows.filter((r) => classify(r) === "unknown").map((r) => r.where);
    expect(rows.length).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
  });

  test("the matrix exercises both public surfaces", () => {
    expect(runEnabled.length).toBeGreaterThan(0);
    expect(runDuration.length).toBeGreaterThan(0);
  });

  test.each(runEnabled.map((r) => [r.where, r]))("%s", (_where, row) => {
    const q = loadedClient();
    expect(q.isEnabled(row.key)).toBe(scalar(row.expected.value));
  });

  test.each(runDuration.map((r) => [r.where, r]))("%s", (_where, row) => {
    const q = loadedClient();
    const defaultMs = row.defaultRaw === undefined ? undefined : scalar(row.defaultRaw);
    const dflt = defaultMs === undefined ? undefined : { ms: defaultMs, seconds: defaultMs / 1000 };
    const got = q.getDuration(row.key, dflt);
    if ("millis" in row.expected) {
      const ms = scalar(row.expected.millis);
      expect(got).toEqual({ ms, seconds: ms / 1000 });
    } else if ("value" in row.expected && scalar(row.expected.value) === null) {
      expect(got).toBeUndefined();
    } else {
      throw new Error(`${row.where}: unrecognized expected ${JSON.stringify(row.expected)}`);
    }
  });
});
