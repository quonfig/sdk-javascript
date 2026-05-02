/**
 * qfg-daxq: Quonfig must expose a subscribe() / dataVersion API so React
 * (and any other UI framework) can re-render when the in-memory config
 * changes — most importantly on poll-fetch deltas.
 */

const { Quonfig } = require("../dist/quonfig");

describe("subscribe() + dataVersion (qfg-daxq)", () => {
  test("setConfig fires subscribers and bumps dataVersion", () => {
    const q = new Quonfig();
    const v0 = q.dataVersion;
    expect(typeof v0).toBe("number");

    const listener = jest.fn();
    const unsubscribe = q.subscribe(listener);

    q.setConfig({ evaluations: { foo: { value: { type: "bool", value: true } } } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(q.dataVersion).toBe(v0 + 1);
    expect(q.get("foo")).toBe(true);

    q.setConfig({ evaluations: { foo: { value: { type: "bool", value: false } } } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(q.dataVersion).toBe(v0 + 2);
    expect(q.get("foo")).toBe(false);

    unsubscribe();
    q.setConfig({ evaluations: {} });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(q.dataVersion).toBe(v0 + 3);
  });

  test("hydrate() also notifies subscribers", () => {
    const q = new Quonfig();
    const listener = jest.fn();
    q.subscribe(listener);

    q.hydrate({ flag: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(q.dataVersion).toBeGreaterThan(0);
  });

  test("a throwing subscriber does not break other subscribers", () => {
    const q = new Quonfig();
    const good = jest.fn();
    q.subscribe(() => {
      throw new Error("nope");
    });
    q.subscribe(good);
    expect(() => q.setConfig({ evaluations: {} })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe removes only the given listener", () => {
    const q = new Quonfig();
    const a = jest.fn();
    const b = jest.fn();
    const unsubA = q.subscribe(a);
    q.subscribe(b);

    q.setConfig({ evaluations: {} });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    q.setConfig({ evaluations: {} });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
