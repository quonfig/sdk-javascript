/**
 * qfg-wg1n: getDetails reports a value that cannot be parsed as its declared
 * type as errorCode PARSE_ERROR (it used to fold it into TYPE_MISMATCH).
 *
 * Covered: a malformed stored int, double and duration (the ITD
 * getter.contract fixtures), a stored value of the wrong JSON shape for its
 * declared type, and an ENV_VAR-provided value that reached the browser
 * unresolved (api-delivery never sends one to a frontend key, qfg-2agi.20,
 * but the client must still classify it). An entry that cannot be decoded
 * at all (a stringified json value) stays TYPE_MISMATCH. getDetails is this
 * SDK's only details API: it has no typed details getters.
 */

const { Quonfig } = require("../dist/quonfig");
const { KEY, loadedClient } = require("./helpers/getterContractMatrix");

const clientWith = (evaluations) => {
  const q = new Quonfig();
  q.setConfig({ evaluations });
  return q;
};

let warnSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const expectParseError = (details) => {
  expect(details.reason).toBe("ERROR");
  expect(details.errorCode).toBe("PARSE_ERROR");
  expect(details.value).toBeUndefined();
  expect(details.variant).toBe("default");
};

describe("getDetails reports PARSE_ERROR for a malformed value (qfg-wg1n)", () => {
  test.each(["int.malformed", "double.malformed"])("stored %s", (name) => {
    const details = loadedClient().getDetails(KEY(name));
    expectParseError(details);
    expect(details.errorMessage).not.toMatch(/twelve|abc/);
  });

  test.each(["P1W", "5m", "PT", "garbage"])("stored duration %j", (value) => {
    const q = clientWith({ "bad.duration": { value: { type: "duration", value }, configId: "d" } });
    expectParseError(q.getDetails("bad.duration"));
  });

  test.each([
    ["bool", "true"],
    ["int", 3.5],
    ["int", "12"],
    ["double", "3.9"],
    ["string", 3],
    ["string_list", "a,b"],
    ["string_list", ["a", 1]],
  ])("stored %s holding %j", (type, value) => {
    const q = clientWith({ k: { value: { type, value }, configId: "c" } });
    expectParseError(q.getDetails("k"));
  });

  test.each(["int", "double", "bool", "duration"])(
    "unresolved ENV_VAR-provided %s value",
    (type) => {
      const q = clientWith({
        "env.key": {
          value: { type, value: { provided: { source: "ENV_VAR", lookup: "MY_VAR" } } },
          configId: "e",
        },
      });
      const details = q.getDetails("env.key");
      expectParseError(details);
      expect(details.errorMessage).not.toContain("MY_VAR");
    }
  );

  test("an entry that cannot be decoded at all stays TYPE_MISMATCH", () => {
    const q = clientWith({ "bad.json": { value: { type: "json", value: '{"a":1}' } } });
    const details = q.getDetails("bad.json");
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("TYPE_MISMATCH");
  });

  test("a well-formed value and a missing key are unchanged", () => {
    const q = loadedClient();
    expect(q.getDetails(KEY("int")).errorCode).toBeUndefined();
    expect(q.getDetails(KEY("int")).value).toBe(30);
    expect(q.getDetails("no.such.key").errorCode).toBe("FLAG_NOT_FOUND");
  });
});
