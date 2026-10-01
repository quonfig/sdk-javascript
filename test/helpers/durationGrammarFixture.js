/**
 * Loads the shared duration grammar fixture from integration-test-data
 * (tests/duration/grammar.yaml, qfg-2agi.29): the ONE definition of which
 * ISO-8601 duration strings Quonfig accepts and what they mean in ms.
 *
 * integration-test-data is a sibling checkout: the monorepo layout locally,
 * and a second actions/checkout in CI (.github/workflows/test.yaml).
 *
 * The fixture uses a deliberately tiny YAML subset, so this reads it without
 * a YAML dependency: `valid:` / `invalid:` section headers, comments, and
 * list items that are either `- { value: "<str>", millis: <int> }` or
 * `- "<str>"`. Double-quoted scalars are decoded with JSON.parse (the escapes
 * the fixture uses, \n and \uXXXX, are the same in both). Any other line
 * throws, so a fixture change this reader cannot handle fails loudly instead
 * of silently dropping cases.
 */
const fs = require("fs");
const path = require("path");

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../integration-test-data/tests/duration/grammar.yaml"
);

const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const VALID_ITEM = new RegExp(
  `^\\s*-\\s*\\{\\s*value:\\s*(${QUOTED}),\\s*millis:\\s*(\\d+)\\s*\\}\\s*$`
);
const INVALID_ITEM = new RegExp(`^\\s*-\\s*(${QUOTED})\\s*$`);

function loadDurationGrammar() {
  const text = fs.readFileSync(FIXTURE_PATH, "utf8");
  const fixture = { valid: [], invalid: [] };
  let section = null;

  text.split("\n").forEach((line, i) => {
    const where = `${FIXTURE_PATH}:${i + 1}`;
    if (/^\s*(#.*)?$/.test(line)) return;
    const header = /^(valid|invalid):\s*$/.exec(line);
    if (header) {
      section = header[1];
      return;
    }
    if (section === "valid") {
      const m = VALID_ITEM.exec(line);
      if (!m) throw new Error(`${where}: unrecognized valid entry: ${line}`);
      const millis = Number(m[2]);
      if (!Number.isSafeInteger(millis)) throw new Error(`${where}: millis not a safe integer`);
      fixture.valid.push({ value: JSON.parse(m[1]), millis });
      return;
    }
    if (section === "invalid") {
      const m = INVALID_ITEM.exec(line);
      if (!m) throw new Error(`${where}: unrecognized invalid entry: ${line}`);
      fixture.invalid.push(JSON.parse(m[1]));
      return;
    }
    throw new Error(`${where}: content outside a valid/invalid section: ${line}`);
  });

  if (fixture.valid.length === 0 || fixture.invalid.length === 0) {
    throw new Error(`${FIXTURE_PATH}: expected non-empty valid and invalid lists`);
  }
  return fixture;
}

module.exports = { loadDurationGrammar, FIXTURE_PATH };
