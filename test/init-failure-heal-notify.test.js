/**
 * qfg-9p4i.11 follow-up (verifier refutation, sdk-react-native lane):
 *
 * 1. A background heal that INSTALLS config must notify subscribers after
 *    readiness flips. setConfig() notified while _ready was still false and the
 *    trailing notify was skipped because something was installed, so
 *    sdk-react's useSyncExternalStore never re-rendered with isReady()=true
 *    (RN repro: useQuonfig() stuck on isReady=false / error / source=defaults
 *    after "init recovered", unless pollInterval was set).
 * 2. Section C log drift: the continue timeout line says "This instance", the
 *    heal line names the leg and version, and the background-retry WARN fires
 *    every 30s even when the retry backoff is longer.
 *
 * Runs without localStorage (React Native / Hermes shape: no LKG).
 */

const { Quonfig, QuonfigInitError } = require("../dist/index");
const { captureConsole } = require("./helpers/captureConsole");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";

const okBody = () =>
  new Response(
    JSON.stringify({
      evaluations: { feature: { value: { type: "bool", value: true } } },
      meta: { version: "gen-7", environment: "Production", generation: 7 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

function network() {
  const net = { mode: "refused" };
  global.fetch = jest.fn(() =>
    net.mode === "up" ? Promise.resolve(okBody()) : Promise.reject(new TypeError("fetch failed"))
  );
  return net;
}

const opts = (extra = {}) => ({
  sdkKey: SDK_KEY,
  context: { user: { key: "alice" } },
  apiUrls: [PRIMARY, SECONDARY],
  collectEvaluationSummaries: false,
  ...extra,
});

describe("init heal notifies readiness; section C log lines", () => {
  let originalFetch;
  let originalLS;
  let log;
  let q;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
    originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
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

  // What a useSyncExternalStore subscriber would read at each notification.
  const watch = (client) => {
    const seen = [];
    client.subscribe(() =>
      seen.push({
        ready: client.isReady(),
        error: client.error,
        feature: client.get("feature"),
      })
    );
    return seen;
  };

  for (const mode of ["fail", "continue"]) {
    test(`${mode}: a background heal without poll() notifies with isReady()=true and no error`, async () => {
      const net = network();
      q = new Quonfig();
      const init = q.init(opts({ onInitFailure: mode }));
      init.catch(() => {});
      await jest.advanceTimersByTimeAsync(5_100);
      expect(q.isReady()).toBe(false);
      if (mode === "fail") expect(q.error).toBeInstanceOf(QuonfigInitError);

      const seen = watch(q);
      net.mode = "up";
      await jest.advanceTimersByTimeAsync(40_000);
      expect(q.isReady()).toBe(true);

      // The LAST notification is what a React store renders: it must show the healed state.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[seen.length - 1]).toEqual({ ready: true, error: undefined, feature: true });
    });
  }

  test("continue timeout WARN says 'This instance may disagree' (section C)", async () => {
    network();
    q = new Quonfig();
    q.init(opts({ onInitFailure: "continue" })).catch(() => {});
    await jest.advanceTimersByTimeAsync(5_100);
    expect(
      log.logCount(
        "warn",
        /onInitFailure=continue: STARTING ON CODE DEFAULTS\. This instance may disagree with the rest of your fleet\. Retrying in background\./
      )
    ).toBe(1);
  });

  test("heal INFO names the leg and version (section C)", async () => {
    const net = network();
    q = new Quonfig();
    q.init(opts()).catch(() => {});
    await jest.advanceTimersByTimeAsync(5_100);
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(
      log.logCount(
        "info",
        /\[quonfig\] init recovered: config loaded after \d+\.\ds via primary \(version gen-7\)\. Now serving live config\./
      )
    ).toBe(1);
  });

  test("background-retry WARN fires every 30s after a caught fail, independent of the retry backoff", async () => {
    network();
    q = new Quonfig();
    q.init(opts()).catch(() => {});
    await jest.advanceTimersByTimeAsync(5_100);
    const bg =
      /\[quonfig\] still not connected to Quonfig delivery \((\d+m)?\d+s since start\); serving defaults\./;
    expect(log.logCount("warn", bg)).toBe(0);

    // Init settled at 5s: the first background line is due 30s later (~35s).
    await jest.advanceTimersByTimeAsync(31_000);
    expect(log.logCount("warn", bg)).toBe(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(log.logCount("warn", bg)).toBe(2);
  });
});
