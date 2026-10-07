/**
 * qfg-goi1.2.6 item 7: importing the SDK must not need crypto.
 *
 * `_instanceHash = uuid()` was a field initializer and `quonfig` is a
 * module-level singleton, so the import itself called uuid(). uuid's browser
 * build throws when crypto.getRandomValues is missing (React Native without
 * the polyfill imported first, some embedded webviews). The id is only a
 * telemetry/instance dedupe id, so it is created lazily and falls back to a
 * non-crypto random id. crypto.randomUUID is not used: it is undefined on
 * insecure (plain http) pages.
 */

const UUID_ERROR = "crypto.getRandomValues() not supported.";

describe("instanceHash without crypto", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("uuid");
  });

  test("importing the SDK does not throw, and instanceHash still returns an id", () => {
    jest.doMock("uuid", () => ({
      v4: () => {
        throw new Error(UUID_ERROR);
      },
    }));
    let mod;
    expect(() => {
      mod = require("../dist/quonfig");
    }).not.toThrow();
    const a = new mod.Quonfig().instanceHash;
    const b = new mod.Quonfig().instanceHash;
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    expect(mod.quonfig.instanceHash).toBe(mod.quonfig.instanceHash); // stable per instance
  });

  test("uses uuid when crypto is available", () => {
    const { Quonfig } = require("../dist/quonfig");
    expect(new Quonfig().instanceHash).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
