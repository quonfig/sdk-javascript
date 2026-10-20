/**
 * qfg-9p4i.11: onInitFailure ("fail" | "wait" | "continue"), an overall
 * initTimeout (5s default), isReady()/error, and no permanently dead clients
 * (project/plans/2026-10-05-init-failure-design.md, sections A.2, B, C).
 *
 * The red shape is the 2026-10-16 audit's dead-client repro: first visit, no
 * last-known-good copy, both legs refused. Before this change init() rejected
 * at once (no retry until a deadline) and the client served defaults for the
 * page's life unless the caller also called poll().
 *
 * Mocked clock throughout (jest modern fake timers also fake Date.now).
 */

const quonfigModule = require("../dist/index");
const { Quonfig, QuonfigInitError } = quonfigModule;
const { writeLkg } = require("../dist/lkgCache");
const { encodeContexts } = require("../dist/context");
const { captureConsole } = require("./helpers/captureConsole");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";
const ALICE = { user: { key: "alice" } };

const okBody = (value, generation = 7) =>
  new Response(
    JSON.stringify({
      evaluations: { feature: { value: { type: "bool", value } } },
      meta: { version: `gen-${generation}`, environment: "Production", generation },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

function fakeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// A switchable network: "refused" fails fast on every leg, "hang" never answers
// (until the per-leg abort), "401" rejects the key, "up" serves feature=true.
function network() {
  const net = { mode: "refused", calls: 0 };
  global.fetch = jest.fn((url, { signal } = {}) => {
    net.calls += 1;
    if (net.mode === "up") return Promise.resolve(okBody(true));
    if (net.mode === "401")
      return Promise.resolve(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    if (net.mode === "hang")
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    return Promise.reject(new TypeError("fetch failed"));
  });
  return net;
}

// Track a promise's outcome without awaiting it.
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.error = e;
    }
  );
  return state;
}

const opts = (extra = {}) => ({
  sdkKey: SDK_KEY,
  context: ALICE,
  apiUrls: [PRIMARY, SECONDARY],
  collectEvaluationSummaries: false,
  ...extra,
});

describe("onInitFailure / initTimeout (qfg-9p4i.11)", () => {
  let originalFetch;
  let originalLS;
  let log;
  let q;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
    originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
      writable: true,
    });
    log = captureConsole();
  });

  afterEach(async () => {
    await q?.close();
    q = undefined;
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalLS) Object.defineProperty(globalThis, "localStorage", originalLS);
    else delete globalThis.localStorage;
    log.restore();
  });

  test("exports QuonfigInitError", () => {
    expect(typeof QuonfigInitError).toBe("function");
    const err = new QuonfigInitError("timeout", "x");
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("timeout");
    expect(err.name).toBe("QuonfigInitError");
  });

  test("default (fail), no cache, both legs refused: retries until initTimeout (5s), rejects, then heals in the background without poll()", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts()));

    await jest.advanceTimersByTimeAsync(4900);
    // Still blocking and retrying: not rejected after the first fast refusal.
    expect(init.settled).toBe(false);
    expect(net.calls).toBeGreaterThan(2);

    await jest.advanceTimersByTimeAsync(200);
    expect(init.settled).toBe(true);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
    expect(init.error.reason).toBe("unavailable");
    expect(q.isReady()).toBe(false);
    expect(q.error).toBe(init.error);
    expect(q.get("feature")).toBeUndefined();

    // Log contract: one WARN on the first failed attempt, one ERROR at the timeout.
    expect(
      log.logCount(
        "warn",
        /\[quonfig\] init: config not loaded yet, retrying until initTimeout \(5s\)\. primary=primary\.quonfig-staging\.com: .*secondary=secondary\.quonfig-staging\.com: /
      )
    ).toBe(1);
    expect(
      log.logCount(
        "error",
        /\[quonfig\] init FAILED: no config after 5\.0s\..*onInitFailure=fail: raising QuonfigInitError/
      )
    ).toBe(1);
    expect(log.lines.some((l) => l.msg.includes(SDK_KEY))).toBe(false);

    // Network returns. The caller never calls poll(): the client heals itself.
    let notified = 0;
    q.subscribe(() => (notified += 1));
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.get("feature")).toBe(true);
    expect(q.isReady()).toBe(true);
    expect(q.error).toBeUndefined();
    expect(notified).toBeGreaterThan(0);
    expect(log.logCount("info", /\[quonfig\] init recovered: config loaded after/)).toBe(1);

    // Healed: the background retry stops (no further fetches without poll()).
    const calls = net.calls;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(net.calls).toBe(calls);
  });

  test("fail + hang on both legs: rejects at initTimeout with reason timeout", async () => {
    network().mode = "hang";
    q = new Quonfig();
    const init = track(q.init(opts()));
    await jest.advanceTimersByTimeAsync(4990);
    expect(init.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
    expect(init.error.reason).toBe("timeout");
  });

  test("initTimeout is configurable", async () => {
    network();
    q = new Quonfig();
    const init = track(q.init(opts({ initTimeout: 1000 })));
    await jest.advanceTimersByTimeAsync(990);
    expect(init.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
  });

  test("fail + 401: rejects immediately with reason unauthorized, not at the timeout", async () => {
    network().mode = "401";
    q = new Quonfig();
    const init = track(q.init(opts()));
    await jest.advanceTimersByTimeAsync(50);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
    expect(init.error.reason).toBe("unauthorized");
    expect(log.logCount("error", /\[quonfig\] init FAILED: SDK key rejected \(401\)/)).toBe(1);
  });

  test("continue, no cache: resolves at initTimeout on defaults, then heals", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "continue" })));
    await jest.advanceTimersByTimeAsync(4900);
    expect(init.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(init.settled).toBe(true);
    expect(init.error).toBeUndefined();
    expect(q.isReady()).toBe(false);
    expect(q.get("feature")).toBeUndefined();
    expect(log.logCount("warn", /onInitFailure=continue: STARTING ON CODE DEFAULTS/)).toBe(1);

    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.get("feature")).toBe(true);
    expect(q.isReady()).toBe(true);
  });

  test("continue + 401: resolves immediately", async () => {
    network().mode = "401";
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "continue" })));
    await jest.advanceTimersByTimeAsync(50);
    expect(init.settled).toBe(true);
    expect(init.error).toBeUndefined();
    expect(q.isReady()).toBe(false);
  });

  test("wait: keeps blocking past initTimeout and resolves once config arrives", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "wait" })));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(init.settled).toBe(false);
    expect(log.logCount("warn", /onInitFailure=wait: still blocking startup/)).toBe(1);

    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(init.settled).toBe(true);
    expect(init.error).toBeUndefined();
    expect(q.isReady()).toBe(true);
    expect(q.get("feature")).toBe(true);
  });

  test("wait + 401: keeps retrying (the key may be provisioned late)", async () => {
    const net = network();
    net.mode = "401";
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "wait" })));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(init.settled).toBe(false);
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(400_000);
    expect(init.settled).toBe(true);
    expect(q.get("feature")).toBe(true);
  });

  test("fail with a cached copy: resolves at once on the cache (stale), then heals to live without poll()", async () => {
    writeLkg(SDK_KEY, encodeContexts(ALICE), {
      generation: 3,
      payload: {
        evaluations: { feature: { value: { type: "bool", value: false } } },
        meta: { version: "gen-3", environment: "Production", generation: 3 },
      },
    });
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts()));
    await jest.advanceTimersByTimeAsync(100);
    expect(init.settled).toBe(true);
    expect(init.error).toBeUndefined();
    expect(q.stale).toBe(true);
    expect(q.get("feature")).toBe(false);
    expect(q.isReady()).toBe(false);

    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.stale).toBe(false);
    expect(q.get("feature")).toBe(true);
    expect(q.isReady()).toBe(true);
  });

  test("healthy boot: resolves on the first answer, ready, no WARN, no timer left behind", async () => {
    const net = network();
    net.mode = "up";
    q = new Quonfig();
    await q.init(opts());
    expect(q.isReady()).toBe(true);
    expect(q.error).toBeUndefined();
    expect(log.logCount("warn")).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("isReady/error are stable between changes (useSyncExternalStore-safe)", async () => {
    network();
    q = new Quonfig();
    const init = track(q.init(opts({ initTimeout: 1000 })));
    await jest.advanceTimersByTimeAsync(1100);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
    expect(q.error).toBe(q.error);
    expect(q.isReady()).toBe(q.isReady());
  });

  test("close() stops the background retry", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts({ initTimeout: 1000 })));
    await jest.advanceTimersByTimeAsync(1100);
    expect(init.settled).toBe(true);
    await q.close();
    const calls = net.calls;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(net.calls).toBe(calls);
  });

  test("poll() takes over from the background retry (no second fetch loop)", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts({ initTimeout: 1000 })));
    await jest.advanceTimersByTimeAsync(1100);
    expect(init.settled).toBe(true);
    q.poll({ frequencyInMs: 60_000 }).catch(() => {});
    await jest.advanceTimersByTimeAsync(0);
    const calls = net.calls;
    // Only the poll loop fetches now: one tick per minute, two legs each.
    await jest.advanceTimersByTimeAsync(59_000);
    expect(net.calls).toBe(calls);
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(2_000);
    expect(q.get("feature")).toBe(true);
    expect(q.isReady()).toBe(true);
  });

  test("wait: a poll() started while init() is pending heals and resolves it", async () => {
    const net = network();
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "wait" })));
    await jest.advanceTimersByTimeAsync(10);
    q.poll({ frequencyInMs: 10_000 }).catch(() => {});
    await jest.advanceTimersByTimeAsync(10_000);
    expect(init.settled).toBe(false);
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(10_000);
    expect(init.settled).toBe(true);
    expect(init.error).toBeUndefined();
    expect(q.get("feature")).toBe(true);
  });

  test("a superseded failing init() settles with the newer init()", async () => {
    const net = network();
    q = new Quonfig();
    const first = track(q.init(opts()));
    await jest.advanceTimersByTimeAsync(1000);
    net.mode = "up";
    const second = track(q.init(opts()));
    await jest.advanceTimersByTimeAsync(5000);
    expect(second.settled).toBe(true);
    expect(second.error).toBeUndefined();
    expect(first.settled).toBe(true);
    expect(first.error).toBeUndefined();
    expect(q.isReady()).toBe(true);
  });

  test("an unknown onInitFailure value warns and falls back to fail", async () => {
    network();
    q = new Quonfig();
    const init = track(q.init(opts({ onInitFailure: "bogus", initTimeout: 1000 })));
    await jest.advanceTimersByTimeAsync(1100);
    expect(init.error).toBeInstanceOf(QuonfigInitError);
    expect(log.logCount("warn", /unknown onInitFailure "bogus"/)).toBe(1);
  });
});
