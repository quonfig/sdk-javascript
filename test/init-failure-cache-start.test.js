/**
 * qfg-9p4i.11 follow-up (adversarial verifier, section C): starting on the
 * cached last-known-good copy must be visible above DEBUG.
 *
 * Verifier scenario: default `fail` mode, a cached copy present, both legs
 * refused, delivery back at 40s. init() resolved at once on the cache
 * (isReady()=false, get() = cached value) and nothing above DEBUG was logged
 * until the INFO heal line. Section C wants one WARN naming the cached config
 * and its age, then the 30s/5-minute "serving cache" background WARN.
 *
 * Second gap: the timeout line (a hanging network, so the cache is not reached
 * before initTimeout) was hard-coded "STARTING ON CODE DEFAULTS" and `fail`
 * rejected even though a cached copy was available. A cache counts as config
 * in every mode, so the timeout starts on it and the line names it with its age.
 */

const { Quonfig } = require("../dist/index");
const { writeLkg } = require("../dist/lkgCache");
const { encodeContexts } = require("../dist/context");
const { captureConsole } = require("./helpers/captureConsole");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";
const ALICE = { user: { key: "alice" } };

const payload = (value, generation) => ({
  evaluations: { feature: { value: { type: "string", value } } },
  meta: { version: `gen-${generation}`, environment: "Production", generation },
});

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

// "refused" fails fast on every leg, "hang" never answers until the per-leg
// abort, "up" serves the live value.
function network() {
  const net = { mode: "refused" };
  global.fetch = jest.fn((url, { signal } = {}) => {
    if (net.mode === "up")
      return Promise.resolve(
        new Response(JSON.stringify(payload("REAL", 9)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    if (net.mode === "hang")
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    return Promise.reject(new TypeError("fetch failed"));
  });
  return net;
}

const opts = (extra = {}) => ({
  sdkKey: SDK_KEY,
  context: ALICE,
  apiUrls: [PRIMARY, SECONDARY],
  collectEvaluationSummaries: false,
  ...extra,
});

const cacheStart = /STARTING ON CACHED CONFIG from (\d+m)?\d+s ago/;
const bgCache =
  /\[quonfig\] still not connected to Quonfig delivery \((\d+m)?\d+s since start\); serving cache\./;

describe("init on a cached last-known-good copy logs per section C", () => {
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
    // Cached 90s before this boot.
    writeLkg(SDK_KEY, encodeContexts(ALICE), { generation: 3, payload: payload("CACHED", 3) });
    jest.advanceTimersByTime(90_000);
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

  const above = () => log.lines.filter((l) => l.level !== "debug");

  test("verifier scenario: default mode, legs refused, delivery back at 40s", async () => {
    const net = network();
    q = new Quonfig();
    let resolved = false;
    q.init(opts()).then(() => (resolved = true));
    await jest.advanceTimersByTimeAsync(10);

    expect(resolved).toBe(true);
    expect(q.isReady()).toBe(false);
    expect(q.get("feature")).toBe("CACHED");

    // One WARN at start naming the cache and its age.
    const start = above();
    expect(start.length).toBe(1);
    expect(start[0].level).toBe("warn");
    expect(start[0].msg).toMatch(
      /^\[quonfig\] init: config not loaded from delivery\. onInitFailure=fail: STARTING ON CACHED CONFIG from 1m30s ago\. This instance may disagree with the rest of your fleet\. Retrying in background\. primary=primary\.quonfig-staging\.com: fetch failed; secondary=secondary\.quonfig-staging\.com: fetch failed\.$/
    );

    // Later cache-fallback attempts do not repeat it; the 30s background WARN covers them.
    await jest.advanceTimersByTimeAsync(29_000);
    expect(log.logCount("warn", cacheStart)).toBe(1);
    expect(log.logCount("warn", bgCache)).toBe(0);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(log.logCount("warn", bgCache)).toBe(1);

    await jest.advanceTimersByTimeAsync(9_500); // t = 40s
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.isReady()).toBe(true);
    expect(q.get("feature")).toBe("REAL");
    expect(log.logCount("warn", cacheStart)).toBe(1);
    expect(
      log.logCount("info", /\[quonfig\] init recovered: .* via primary \(version gen-9\)/)
    ).toBe(1);
  });

  test("a cached copy written before ages were recorded still logs the cache start", async () => {
    globalThis.localStorage.setItem(
      `quonfig.lkg.v2:${SDK_KEY}`,
      JSON.stringify({
        ...JSON.parse(globalThis.localStorage.getItem(`quonfig.lkg.v2:${SDK_KEY}`)),
        savedAt: undefined,
      })
    );
    network();
    q = new Quonfig();
    await q.init(opts());
    expect(q.get("feature")).toBe("CACHED");
    expect(log.logCount("warn", /STARTING ON CACHED CONFIG \(age unknown\)\./)).toBe(1);
  });

  for (const mode of ["continue", "fail", "wait"]) {
    test(`${mode}: the timeout with a hanging network starts on the cache and names it with its age`, async () => {
      const net = network();
      net.mode = "hang";
      q = new Quonfig();
      let outcome;
      q.init(opts({ onInitFailure: mode })).then(
        () => (outcome = "resolved"),
        (e) => (outcome = e)
      );
      await jest.advanceTimersByTimeAsync(4_900);
      expect(outcome).toBeUndefined();
      await jest.advanceTimersByTimeAsync(200);

      expect(outcome).toBe("resolved");
      expect(q.isReady()).toBe(false);
      expect(q.get("feature")).toBe("CACHED");
      expect(
        log.logCount(
          "warn",
          new RegExp(
            `^\\[quonfig\\] init: no config after 5\\.0s\\. onInitFailure=${mode}: STARTING ON CACHED CONFIG from 1m35s ago\\. ` +
              `This instance may disagree with the rest of your fleet\\. Retrying in background\\.`
          )
        )
      ).toBe(1);
      expect(log.logCount("warn", /STARTING ON CODE DEFAULTS/)).toBe(0);
      expect(log.logCount("error")).toBe(0);
      expect(log.logCount("warn", cacheStart)).toBe(1);
    });
  }
});
