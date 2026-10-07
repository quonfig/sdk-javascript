const { Config } = require("../dist/config");

describe("Config.digest — json valueType", () => {
  test("returns native object value as-is", () => {
    const payload = {
      evaluations: {
        "my.json": {
          value: {
            type: "json",
            value: { foo: "bar", n: 42, arr: [1, 2, 3], nested: { x: true } },
          },
          configId: "cfg-1",
          configType: "CONFIG",
          valueType: "json",
        },
      },
    };

    const configs = Config.digest(payload);

    expect(configs["my.json"].value).toEqual({
      foo: "bar",
      n: 42,
      arr: [1, 2, 3],
      nested: { x: true },
    });
    // Not a string — must be the native object.
    expect(typeof configs["my.json"].value).toBe("object");
  });

  test("returns native array value as-is", () => {
    const payload = {
      evaluations: {
        "my.list": {
          value: { type: "json", value: [1, 2, "three"] },
          configId: "cfg-2",
          configType: "CONFIG",
          valueType: "json",
        },
      },
    };

    const configs = Config.digest(payload);
    expect(configs["my.list"].value).toEqual([1, 2, "three"]);
    expect(Array.isArray(configs["my.list"].value)).toBe(true);
  });

  test("rejects stringified json for that key only — strict wire contract, matches sdk-go / sdk-python", () => {
    // Server now always sends native. If a stringified value ever leaks
    // through, the SDK must reject it loudly — matches sdk-go (unmarshal
    // reject) and sdk-python (QuonfigValueTypeError). No silent
    // pass-through or JSON.parse fallback. The rejection is per key
    // (qfg-goi1.2.6): the key gets no value and a coercionError, and the rest
    // of the payload still decodes.
    const payload = {
      evaluations: {
        "legacy.str": {
          value: { type: "json", value: '{"foo":"bar"}' },
          configId: "cfg-3",
          configType: "CONFIG",
          valueType: "json",
        },
      },
    };

    const configs = Config.digest(payload);
    expect(configs["legacy.str"].value).toBeUndefined();
    expect(configs["legacy.str"].coercionError).toMatch(/json value must be a native JSON type/);
    expect(configs["legacy.str"].coercionError).not.toContain("bar");
    expect(configs["legacy.str"].configEvaluationMetadata.configId).toBe("cfg-3");
  });

  test("returns native scalar json values (number, bool, null)", () => {
    const payload = {
      evaluations: {
        n: {
          value: { type: "json", value: 7 },
          configId: "a",
          configType: "CONFIG",
          valueType: "json",
        },
        b: {
          value: { type: "json", value: true },
          configId: "b",
          configType: "CONFIG",
          valueType: "json",
        },
        z: {
          value: { type: "json", value: null },
          configId: "c",
          configType: "CONFIG",
          valueType: "json",
        },
      },
    };

    const configs = Config.digest(payload);
    expect(configs["n"].value).toBe(7);
    expect(configs["b"].value).toBe(true);
    expect(configs["z"].value).toBeNull();
  });
});
