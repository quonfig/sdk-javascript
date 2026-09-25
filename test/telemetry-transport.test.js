/**
 * Telemetry transport contract, browser subset (qfg-y8je.11): T1, T2, T3, T7
 * and the pagehide check in place of T8, from
 * integration-test-data/chaos/telemetry-transport-contract.md, plus the three
 * sdk-javascript 1.2.1 bug regressions (shared abort timer, unhandled
 * rejection on a network error, timers left armed by close()).
 *
 * Fixture: a real Quonfig client (real reporter, queue and uploader) with only
 * `fetch` scripted (no sockets), jest fake timers for the tick timer, the
 * per-POST deadline and every Date.now() comparison, and console spies as the
 * capturing logger. Browser defaults: 30s flush interval, 10s timeout,
 * 5 batches / 512KB / 5 min retention.
 */

const { Quonfig } = require("../dist/quonfig");
const { telemetryFetch } = require("./helpers/telemetryFetch");
const { captureConsole } = require("./helpers/captureConsole");

const INTERVAL = 30_000;
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";

const pad = (i) => String(i).padStart(2, "0");

function evaluations() {
  const out = {};
  for (let i = 0; i < 30; i++) {
    out[`flag-${pad(i)}`] = {
      value: { type: "bool", value: true },
      configId: `id-${i}`,
      configType: "FEATURE_FLAG",
      valueType: "bool",
      configRowIndex: 0,
      conditionalValueIndex: 0,
    };
  }
  // Telemetry debug lines print only when this log-level config allows DEBUG.
  out["log-level.quonfig-javascript.quonfig.telemetry"] = {
    value: { type: "log_level", value: "DEBUG" },
    configId: "id-log",
    configType: "LOG_LEVEL",
    valueType: "log_level",
  };
  return { evaluations: out };
}

/** Evaluation set: three distinct flags starting at `base`, so a body identifies its set by key. */
const SETS = { A: 0, B: 3, C: 6, D: 9, E: 12 };
const setKeys = (...tags) =>
  tags.flatMap((t) => [0, 1, 2].map((i) => `flag-${pad(SETS[t] + i)}`)).sort();

function record(client, tag) {
  for (const key of setKeys(tag)) client.get(key);
}

/** Let promise chains finish between fake-timer steps (real setImmediate). */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  await settle();
}

let tf;
let log;
let q;
let originalFetch;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  originalFetch = global.fetch;
  tf = telemetryFetch();
  global.fetch = tf.fetch;
});

afterEach(async () => {
  if (q) {
    const closing = q.close().catch(() => undefined);
    await advance(5_000);
    await closing;
  }
  q = undefined;
  log?.restore();
  log = undefined;
  delete global.window;
  global.fetch = originalFetch;
  jest.useRealTimers();
});

async function client(overrides = {}) {
  q = new Quonfig();
  const init = q.init({
    sdkKey: "qf_pk_development_test",
    context: { user: { key: "alice" } },
    apiUrls: [PRIMARY, SECONDARY],
    telemetryUrl: "https://telemetry.quonfig-staging.com",
    ...overrides,
  });
  await jest.advanceTimersByTimeAsync(0);
  await init;
  q.setConfig(evaluations());
  log = captureConsole();
  return { q, r: q.telemetryReporter };
}

describe("T1 timeout aborts and retains (P1, P5, P7)", () => {
  test("T1 timeout aborts and retains", async () => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ hang: true }, { status: 200 });

    await advance(INTERVAL); // tick 1: POST 0 hangs
    expect(tf.postCount()).toBe(1);

    await advance(10_000); // the 10s browser deadline aborts it
    expect(tf.postCount()).toBe(1);
    expect(r.debugState().retainedCount).toBe(1);
    expect(log.logCount("warn")).toBe(0);
    expect(log.logCount("error")).toBe(0);
    expect(log.logCount("debug", /Telemetry POST failed \(timeout\)/)).toBe(1);

    // Tick 2 (60s) is only 20s after the failure at 40s: the 30s floor holds it.
    await advance(20_000);
    expect(tf.postCount()).toBe(1);

    await advance(INTERVAL); // tick 3 (90s), 50s after the failure
    expect(tf.postCount()).toBe(2);
    expect(tf.sha(1)).toBe(tf.sha(0));
    expect(r.debugState().retainedCount).toBe(0);
    expect(log.logCount("info", /recover/i)).toBe(1);
    expect(log.logCount("warn")).toBe(0);
  });

  test("T1 defaults: timeout 10000, interval 30000, 5 / 524288 / 300000, 10000 summaries", async () => {
    const { r } = await client();
    expect(r.config).toEqual({
      flushIntervalMs: 30_000,
      timeoutMs: 10_000,
      maxRetainedBatches: 5,
      maxRetainedBytes: 524_288,
      maxRetainedAgeMs: 300_000,
      maxEvaluationSummaries: 10_000,
    });
    const { TELEMETRY_DEFAULTS } = require("../dist/telemetry/transportQueue");
    expect(TELEMETRY_DEFAULTS.timeoutMs).toBe(10_000);
    expect(TELEMETRY_DEFAULTS.maxRetainedBytes).toBe(524_288);
  });

  test("T1 the eval-fetch `timeout` option no longer sets the telemetry timeout", async () => {
    const { r } = await client({ timeout: 5_000 });
    expect(r.config.timeoutMs).toBe(10_000);
  });

  test("T1 telemetry* options override the defaults; invalid values fall back", async () => {
    const { r } = await client({
      telemetryTimeoutMs: 2_500,
      telemetryFlushIntervalMs: 8_000,
      telemetryMaxRetainedBatches: 2,
      telemetryMaxRetainedBytes: 4_096,
      telemetryMaxRetainedAgeMs: -1,
      telemetryMaxEvaluationSummaries: Number.NaN,
    });
    expect(r.config).toEqual({
      flushIntervalMs: 8_000,
      timeoutMs: 2_500,
      maxRetainedBatches: 2,
      maxRetainedBytes: 4_096,
      maxRetainedAgeMs: 300_000,
      maxEvaluationSummaries: 10_000,
    });
  });
});

describe("T2 5xx retains verbatim and resends (P4, P5)", () => {
  test("T2 5xx retains verbatim and resends", async () => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ status: 503 }, { status: 503 }, { status: 200 }, { status: 200 });

    await advance(INTERVAL); // tick 1: POST 0 carries A, 503
    expect(tf.postCount()).toBe(1);
    expect(r.debugState().retainedCount).toBe(1);

    record(q, "B");
    await advance(INTERVAL); // tick 2 (30s after the failure): POST 1 = A again, 503; B queued behind
    expect(tf.postCount()).toBe(2);
    expect(r.debugState().retainedCount).toBe(2);

    await advance(INTERVAL); // tick 3: POST 2 = A (200), POST 3 = B (200)
    expect(tf.postCount()).toBe(4);
    expect(tf.sha(1)).toBe(tf.sha(0));
    expect(tf.sha(2)).toBe(tf.sha(0));
    expect(tf.keys(0)).toEqual(setKeys("A"));
    expect(tf.keys(3)).toEqual(setKeys("B"));
    expect(r.debugState().retainedCount).toBe(0);
    expect(log.logCount("warn")).toBe(0);
  });
});

describe("T3 non-retryable 4xx (P3)", () => {
  test.each([401, 403, 404])("T3a %i disables telemetry for the page", async (status) => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ status: 503 }, { status });

    await advance(INTERVAL); // one retained batch first
    expect(r.debugState().retainedCount).toBe(1);

    record(q, "B");
    await advance(INTERVAL); // POST 1 answers `status`
    expect(tf.postCount()).toBe(2);
    expect(log.logCount("error", new RegExp(String(status)))).toBe(1);
    expect(r.debugState().enabled).toBe(false);
    expect(r.debugState().retainedCount).toBe(0);
    expect(log.logCount("warn")).toBe(0);

    for (let i = 0; i < 3; i++) {
      record(q, "C");
      await advance(INTERVAL);
    }
    expect(tf.postCount()).toBe(2);
    expect(log.logCount("error")).toBe(1);
    // Flag evaluation is unaffected.
    expect(q.get("flag-00")).toBe(true);
  });

  test.each([400, 413, 422])("T3b %i drops the batch and keeps ticking", async (status) => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ status, body: "bad payload" }, { status: 200 });

    await advance(INTERVAL);
    expect(tf.postCount()).toBe(1);
    expect(r.debugState().retainedCount).toBe(0);
    expect(log.logCount("error")).toBe(1);
    expect(log.logCount("error", new RegExp(String(status)))).toBe(1);
    expect(log.logCount("warn")).toBe(0);
    expect(r.debugState().enabled).toBe(true);

    record(q, "B");
    await advance(INTERVAL);
    expect(tf.postCount()).toBe(2);
    expect(tf.body(1)).not.toBe(tf.body(0));
    expect(tf.keys(1)).toEqual(setKeys("B"));
  });

  test("T3 408 is retryable (anti-vacuity)", async () => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ status: 408 });

    await advance(INTERVAL);
    expect(r.debugState().retainedCount).toBe(1);
    expect(r.debugState().enabled).toBe(true);
    expect(log.logCount("error")).toBe(0);
  });
});

describe("T7 one POST in flight (P2)", () => {
  test("T7 one POST in flight; skipped windows aggregate", async () => {
    const { q, r } = await client();
    record(q, "A");
    tf.script({ hang: true });

    await advance(INTERVAL); // POST 0 carries A and hangs
    expect(tf.postCount()).toBe(1);

    record(q, "B");
    await r.tick();
    record(q, "C");
    await r.tick();
    await settle();
    expect(tf.postCount()).toBe(1);

    tf.release(0, { status: 200 }); // before the 10s deadline
    await settle();

    await r.tick();
    await settle();
    expect(tf.postCount()).toBe(2);
    expect(tf.keys(0)).toEqual(setKeys("A"));
    expect(tf.keys(1)).toEqual(setKeys("B", "C"));
  });
});

describe("pagehide final flush (P8, browser)", () => {
  test("pagehide sends the live window once with keepalive, 2s budget, never drains the retained queue", async () => {
    global.window = new EventTarget();
    const { q, r } = await client();
    record(q, "A");
    tf.script({ status: 503 });
    await advance(INTERVAL); // A retained
    expect(r.debugState().retainedCount).toBe(1);

    record(q, "B");
    tf.setDefault({ hang: true });
    window.dispatchEvent(new Event("pagehide"));

    // The handler returned while the POST is still outstanding: it never blocks.
    expect(tf.postCount()).toBe(2);
    expect(tf.post(1).options.keepalive).toBe(true);
    expect(tf.keys(1)).toEqual(setKeys("B"));
    expect(tf.sha(1)).not.toBe(tf.sha(0));

    await advance(2_000); // the 2s budget aborts the hanging final flush
    expect(tf.postCount()).toBe(2);
    expect(log.logCount("debug", /final flush/)).toBe(1);
    expect(log.logCount("warn")).toBe(0);
    // The retained batch was neither sent nor dropped.
    expect(r.debugState().retainedCount).toBe(1);

    // Nothing new recorded: a second pagehide sends nothing.
    window.dispatchEvent(new Event("pagehide"));
    expect(tf.postCount()).toBe(2);
  });

  test("close() removes the pagehide listener", async () => {
    global.window = new EventTarget();
    const { q } = await client();
    const closing = q.close();
    await advance(0);
    await closing;
    q.setConfig(evaluations());
    record(q, "A");
    window.dispatchEvent(new Event("pagehide"));
    expect(tf.postCount()).toBe(0);
  });
});

describe("1.2.1 bug regressions", () => {
  test("a second POST cannot disarm the first POST's deadline (shared abort timer)", async () => {
    await client();
    const uploader = q.telemetryUploader;
    tf.script({ status: 200 }, { hang: true });

    const first = uploader.post({ a: 1 });
    const second = uploader.post({ b: 2 });
    let secondState = "pending";
    second.then(
      () => (secondState = "resolved"),
      () => (secondState = "rejected")
    );
    await expect(first).resolves.toBeDefined();

    await advance(10_000);
    expect(secondState).toBe("rejected");
  });

  test("a network error rejects nothing unhandled and is retryable", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { q, r } = await client();
      record(q, "A");
      tf.script({ networkError: true }, { status: 200 });

      await advance(INTERVAL);
      expect(tf.postCount()).toBe(1);
      expect(r.debugState().retainedCount).toBe(1);
      expect(log.logCount("debug", /Telemetry POST failed \(network error/)).toBe(1);
      expect(log.logCount("warn")).toBe(0);

      await advance(INTERVAL);
      expect(tf.postCount()).toBe(2);
      expect(tf.sha(1)).toBe(tf.sha(0));
      expect(log.logCount("info", /recover/i)).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("close() leaves no timers armed, even when the final POST fails", async () => {
    const { q } = await client();
    record(q, "A");
    tf.setDefault({ networkError: true });

    const closing = q.close();
    await advance(0);
    await expect(closing).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);

    record(q, "B");
    await advance(10 * INTERVAL);
    expect(tf.postCount()).toBe(1);
  });
});

describe("aggregator cap (P6)", () => {
  test("keys beyond the cap are dropped; existing keys keep counting", async () => {
    const { q } = await client({ telemetryMaxEvaluationSummaries: 3 });
    record(q, "A"); // fills the cap with flag-00..02
    record(q, "B"); // beyond the cap: not recorded
    q.get("flag-00"); // existing key still increments

    await advance(INTERVAL);
    expect(tf.postCount()).toBe(1);
    expect(tf.keys(0)).toEqual(setKeys("A"));
    const summaries = JSON.parse(tf.body(0)).events[0].summaries.summaries;
    expect(summaries.find((s) => s.key === "flag-00").counters[0].count).toBe(2);
  });
});
