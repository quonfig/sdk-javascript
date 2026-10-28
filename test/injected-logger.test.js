/**
 * qfg-qgnw: an injected `logger` init option receives every SDK log line,
 * including the section-C init lines ("[quonfig] init FAILED", "init
 * recovered"), and nothing reaches `console`. Same shape as sdk-node's
 * `logger`: `warn`/`error` required, `debug`/`info` optional (no-ops when
 * absent). Omitting it keeps the console output unchanged.
 */

const { Quonfig, QuonfigInitError } = require("../dist/index");
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

function network() {
  const net = { mode: "refused" };
  global.fetch = jest.fn(() => {
    if (net.mode === "up") return Promise.resolve(okBody(true));
    if (net.mode === "401")
      return Promise.resolve(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    return Promise.reject(new TypeError("fetch failed"));
  });
  return net;
}

function recordingLogger({ withOptional = true } = {}) {
  const lines = [];
  const rec =
    (level) =>
    (message, ...args) =>
      lines.push({ level, message, args });
  const logger = { warn: rec("warn"), error: rec("error") };
  if (withOptional) {
    logger.debug = rec("debug");
    logger.info = rec("info");
  }
  return {
    logger,
    lines,
    count: (level, re = /.*/) =>
      lines.filter((l) => l.level === level && re.test(l.message)).length,
  };
}

const opts = (extra = {}) => ({
  sdkKey: SDK_KEY,
  context: ALICE,
  apiUrls: [PRIMARY, SECONDARY],
  collectEvaluationSummaries: false,
  ...extra,
});

describe("injected logger (qfg-qgnw)", () => {
  let originalFetch;
  let consoleLog;
  let q;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
    consoleLog = captureConsole();
  });

  afterEach(async () => {
    await q?.close();
    q = undefined;
    jest.useRealTimers();
    global.fetch = originalFetch;
    consoleLog.restore();
  });

  test("init FAILED and init recovered go to the injected logger, not console", async () => {
    const net = network();
    const rec = recordingLogger();
    q = new Quonfig();
    const init = q.init(opts({ logger: rec.logger })).catch((e) => e);

    await jest.advanceTimersByTimeAsync(5100);
    const err = await init;
    expect(err).toBeInstanceOf(QuonfigInitError);

    expect(rec.count("debug", /\[quonfig\] init: fetching config/)).toBe(1);
    expect(rec.count("warn", /\[quonfig\] init: config not loaded yet/)).toBe(1);
    expect(rec.count("error", /\[quonfig\] init FAILED: no config after 5\.0s/)).toBe(1);

    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.isReady()).toBe(true);
    expect(rec.count("info", /\[quonfig\] init recovered: config loaded after/)).toBe(1);

    expect(consoleLog.lines).toEqual([]);
  });

  test("401 under fail: the ERROR line reaches the injected logger", async () => {
    const net = network();
    net.mode = "401";
    const rec = recordingLogger();
    q = new Quonfig();
    const err = await q.init(opts({ logger: rec.logger })).catch((e) => e);
    expect(err).toBeInstanceOf(QuonfigInitError);
    expect(rec.count("error", /\[quonfig\] init FAILED: SDK key rejected \(401\)/)).toBe(1);
    expect(consoleLog.lines).toEqual([]);
  });

  test("init-time warnings and pre-load reads route through the logger", async () => {
    network();
    const rec = recordingLogger();
    q = new Quonfig();
    const init = q
      .init(
        opts({
          logger: rec.logger,
          apiUrls: [PRIMARY],
          timeout: 100,
          hedgeDelay: 200,
          onInitFailure: "continue",
          context: { user: { key: "alice", nested: { a: 1 } } },
        })
      )
      .catch((e) => e);
    expect(q.get("feature")).toBeUndefined();
    await jest.advanceTimersByTimeAsync(5100);
    await init;

    expect(rec.count("warn", /timeout \(100ms\) is not above hedgeDelay/)).toBe(1);
    expect(rec.count("warn", /explicit apiUrls disables automatic failover/)).toBe(1);
    expect(rec.count("error", /Nested objects are not supported/)).toBe(1);
    expect(rec.count("warn", /has not finished loading data yet/)).toBe(1);
    expect(consoleLog.lines).toEqual([]);
  });

  test("a logger with only warn/error: debug/info become no-ops, nothing hits console", async () => {
    const net = network();
    const rec = recordingLogger({ withOptional: false });
    q = new Quonfig();
    const init = q.init(opts({ logger: rec.logger, onInitFailure: "continue" }));
    await jest.advanceTimersByTimeAsync(5100);
    await init;
    net.mode = "up";
    await jest.advanceTimersByTimeAsync(40_000);
    expect(q.isReady()).toBe(true);
    expect(rec.count("warn", /onInitFailure=continue: STARTING ON CODE DEFAULTS/)).toBe(1);
    expect(consoleLog.lines).toEqual([]);
  });

  test("without a logger, the same lines still go to console (unchanged default)", async () => {
    network();
    q = new Quonfig();
    const err = await q.init(opts({ initTimeout: 0 })).catch((e) => e);
    expect(err).toBeInstanceOf(QuonfigInitError);
    expect(consoleLog.logCount("debug", /\[quonfig\] init: fetching config/)).toBe(1);
    expect(consoleLog.logCount("error", /\[quonfig\] init FAILED/)).toBe(1);
  });
});
