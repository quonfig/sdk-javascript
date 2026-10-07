/**
 * qfg-goi1.2.6 item 5: prototype-property names are not configs. `_configs`
 * was a plain object, so getDetails("constructor") found Object.prototype's
 * constructor and reported a STATIC value instead of FLAG_NOT_FOUND. Config
 * keys like `constructor` are legal key syntax, so the maps must have no
 * prototype.
 */

const { Quonfig, Config } = require("../dist");

const PROTO_KEYS = ["constructor", "toString", "hasOwnProperty", "__proto__"];

describe("prototype-property keys", () => {
  test("a loaded client reports FLAG_NOT_FOUND for prototype names", () => {
    const q = new Quonfig();
    q.setConfig({ evaluations: { real: { value: { type: "bool", value: true } } } });
    for (const key of PROTO_KEYS) {
      expect(q.getDetails(key).errorCode).toBe("FLAG_NOT_FOUND");
    }
  });

  test("hydrate() keeps the map prototype-free", () => {
    const q = new Quonfig();
    q.hydrate({ real: true });
    expect(q.getDetails("constructor").errorCode).toBe("FLAG_NOT_FOUND");
    expect(q.get("real")).toBe(true);
  });

  test("Config.digest returns a prototype-free map", () => {
    const configs = Config.digest({ evaluations: {} });
    expect(configs.constructor).toBeUndefined();
  });
});
