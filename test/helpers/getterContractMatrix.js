/**
 * The getter.contract fixtures from integration-test-data (qfg-zvyy.1), in
 * the form api-delivery's eval-with-context sends them to a frontend key:
 * ints and doubles as JSON numbers, everything else as stored.
 *
 * Shared by test/typed-getter-contract.test.js (the hand-written matrix) and
 * test/itd-getter-contract.test.js (the drift guard that reads the ITD
 * fixtures and YAML from the sibling integration-test-data checkout and fails
 * when they no longer match this table).
 *
 * The ENV_VAR fixtures (getter.contract.provided.*) are not here: a provided
 * value is never sent to a frontend key (qfg-2agi.20), so on the browser
 * those keys are missing.
 */
const { Quonfig } = require("../../dist/quonfig");

const STORED = {
  bool: { type: "bool", value: true },
  string: { type: "string", value: "fast" },
  int: { type: "int", value: 30 },
  double: { type: "double", value: 3.9 },
  "double.whole": { type: "double", value: 3 },
  "double.huge": { type: "double", value: 1e300 },
  "double.unsafe": { type: "double", value: 9007199254740992 },
  string_list: { type: "string_list", value: ["a", "b"] },
  json: { type: "json", value: { a: 1 } },
  duration: { type: "duration", value: "PT30S" },
  "string.false": { type: "string", value: "false" },
  "string.true": { type: "string", value: "true" },
  "string.number": { type: "string", value: "3" },
  "string.duration": { type: "string", value: "PT1S" },
  "int.malformed": { type: "int", value: "twelve" },
  "double.malformed": { type: "double", value: "abc" },
};

const KEY = (name) => `getter.contract.${name}`;

const evaluationFor = (name) => ({
  value: STORED[name],
  configId: `cfg-${name}`,
  configType: "config",
  valueType: STORED[name].type,
  reason: "STATIC",
});

const loadedClient = () => {
  const q = new Quonfig();
  const evaluations = {};
  Object.keys(STORED).forEach((name) => {
    evaluations[KEY(name)] = evaluationFor(name);
  });
  q.setConfig({ evaluations });
  return q;
};

module.exports = { STORED, KEY, evaluationFor, loadedClient };
