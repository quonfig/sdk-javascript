/**
 * qfg-9p4i.17.7 (and qfg-9p4i.16): cross-SDK init-failure conformance
 * (project/plans/2026-10-05-init-failure-design.md, "Decisions (Jeff,
 * 2026-10-21)" 6-9).
 *
 * - D1: init decides "unauthorized" only when EVERY configured leg answered
 *   401/403/404/410, never from the primary alone. Under `wait` the rejection
 *   logs at WARN (client SDK), not ERROR.
 * - D2: reason is "timeout" iff the LAST attempt hung (every leg in it ended on
 *   a timeout/abort) or no attempt completed; otherwise "unavailable".
 * - D3: initTimeout <= 0 runs exactly one attempt, then applies onInitFailure.
 * - D4: init log lines and the init error carry hosts and "HTTP <status>" only,
 *   never URL userinfo or raw upstream bodies (including the error's cause).
 * - stopPolling() while init() is pending must not kill the init retry loop.
 *
 * Mocked clock throughout (jest modern fake timers also fake Date.now).
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

const status = (code) => new Response("upstream body", { status: code, statusText: "x" });

const hang = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });

const delayed = (ms, fn) =>
  new Promise((resolve, reject) => setTimeout(() => fn(resolve, reject), ms));

// Route each request by leg: `handlers.primary` / `handlers.secondary` are
// (signal) => Promise<Response>.
function legs(handlers) {
  const net = { calls: 0, handlers };
  global.fetch = jest.fn((url, { signal } = {}) => {
    net.calls += 1;
    const leg = String(url).startsWith(PRIMARY) ? "primary" : "secondary";
    return net.handlers[leg](signal, url);
  });
  return net;
}

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

const refused = () => Promise.reject(new TypeError("fetch failed"));
const up = () => Promise.resolve(okBody(true));

describe("init-failure conformance (qfg-9p4i.17.7)", () => {
  let originalFetch;
  let log;
  let q;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
    log = captureConsole();
  });

  afterEach(async () => {
    await q?.close();
    q = undefined;
    jest.useRealTimers();
    global.fetch = originalFetch;
    log.restore();
  });

  describe("D1: unauthorized only when every leg is auth-class", () => {
    test("primary 401 + secondary 503 is not unauthorized: retries to the deadline, reason unavailable", async () => {
      legs({
        primary: () => Promise.resolve(status(401)),
        secondary: () => Promise.resolve(status(503)),
      });
      q = new Quonfig();
      const init = track(q.init(opts()));
      await jest.advanceTimersByTimeAsync(100);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(5000);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(init.error.reason).toBe("unavailable");
      expect(log.logCount("error", /SDK key rejected/)).toBe(0);
    });

    test("primary 503 + secondary 401 is not unauthorized", async () => {
      legs({
        primary: () => Promise.resolve(status(503)),
        secondary: () => Promise.resolve(status(401)),
      });
      q = new Quonfig();
      const init = track(q.init(opts()));
      await jest.advanceTimersByTimeAsync(100);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(5000);
      expect(init.error.reason).toBe("unavailable");
    });

    test("primary 401 + secondary hang is not unauthorized", async () => {
      legs({ primary: () => Promise.resolve(status(401)), secondary: (signal) => hang(signal) });
      q = new Quonfig();
      const init = track(q.init(opts()));
      await jest.advanceTimersByTimeAsync(4000);
      expect(init.settled).toBe(false);
    });

    test("both legs 403/410: unauthorized at once, 'by primary and secondary'", async () => {
      legs({
        primary: () => Promise.resolve(status(403)),
        secondary: () => Promise.resolve(status(410)),
      });
      q = new Quonfig();
      const init = track(q.init(opts()));
      await jest.advanceTimersByTimeAsync(50);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(init.error.reason).toBe("unauthorized");
      expect(
        log.logCount(
          "error",
          /\[quonfig\] init FAILED: SDK key rejected \(403\) by primary and secondary\. Check the key and environment\. onInitFailure=fail: raising now\./
        )
      ).toBe(1);
    });

    test("a single configured leg answering 404: unauthorized at once, 'by primary'", async () => {
      legs({ primary: () => Promise.resolve(status(404)), secondary: up });
      q = new Quonfig();
      const init = track(q.init(opts({ apiUrls: [PRIMARY] })));
      await jest.advanceTimersByTimeAsync(50);
      expect(init.error.reason).toBe("unauthorized");
      expect(log.logCount("error", /SDK key rejected \(404\) by primary\. Check/)).toBe(1);
    });

    test("wait + every leg 401: logs at WARN, never ERROR (qfg-9p4i.16)", async () => {
      const net = legs({
        primary: () => Promise.resolve(status(401)),
        secondary: () => Promise.resolve(status(401)),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ onInitFailure: "wait" })));
      await jest.advanceTimersByTimeAsync(10_000);
      expect(init.settled).toBe(false);
      expect(log.logCount("error")).toBe(0);
      expect(
        log.logCount(
          "warn",
          /\[quonfig\] init: SDK key rejected \(401\) by primary and secondary\. Check the key and environment\. onInitFailure=wait/
        )
      ).toBe(1);
      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(400_000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
    });
  });

  describe("D2: reason follows the last attempt", () => {
    test("first attempt refused, later attempts hang: timeout", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts()));
      await jest.advanceTimersByTimeAsync(10);
      net.handlers = { primary: (s) => hang(s), secondary: (s) => hang(s) };
      await jest.advanceTimersByTimeAsync(5100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(init.error.reason).toBe("timeout");
    });

    test("single leg that hangs (per-leg abort before the deadline): timeout", async () => {
      legs({ primary: (s) => hang(s), secondary: (s) => hang(s) });
      q = new Quonfig();
      const init = track(q.init(opts({ apiUrls: [PRIMARY] })));
      await jest.advanceTimersByTimeAsync(5100);
      expect(init.error.reason).toBe("timeout");
    });

    test("hang first, then refused on the last attempt: unavailable", async () => {
      const net = legs({ primary: (s) => hang(s), secondary: (s) => hang(s) });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 10_000 })));
      await jest.advanceTimersByTimeAsync(6000);
      net.handlers = { primary: refused, secondary: refused };
      await jest.advanceTimersByTimeAsync(4100);
      expect(init.error.reason).toBe("unavailable");
    });

    test("an attempt in flight at the deadline whose fast leg refused: unavailable", async () => {
      legs({ primary: (s) => hang(s), secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ apiUrls: [PRIMARY, SECONDARY], initTimeout: 2500 })));
      await jest.advanceTimersByTimeAsync(2600);
      expect(init.error.reason).toBe("unavailable");
    });
  });

  describe("D3: initTimeout <= 0 runs one attempt, then the policy", () => {
    test("0 + a healthy (slow) network resolves on the first attempt instead of failing at once", async () => {
      legs({
        primary: () => delayed(100, (resolve) => resolve(okBody(true))),
        secondary: up,
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0 })));
      await jest.advanceTimersByTimeAsync(50);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
      expect(q.get("feature")).toBe(true);
    });

    test("0 + fail + refused: rejects after exactly one attempt, reason unavailable, then heals", async () => {
      const net = legs({
        primary: () => delayed(100, (_, reject) => reject(new TypeError("fetch failed"))),
        secondary: () => delayed(100, (_, reject) => reject(new TypeError("fetch failed"))),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0 })));
      await jest.advanceTimersByTimeAsync(150);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(init.error.reason).toBe("unavailable");
      expect(net.calls).toBe(2);
      expect(log.logCount("error", /init FAILED: no config after/)).toBe(1);

      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(5000);
      expect(q.isReady()).toBe(true);
    });

    test("a negative initTimeout behaves as 0 (one attempt), not the 5s default", async () => {
      legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: -1 })));
      await jest.advanceTimersByTimeAsync(50);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(init.error.reason).toBe("unavailable");
    });

    test("0 + hang: one attempt that hangs ends with reason timeout", async () => {
      legs({ primary: (s) => hang(s), secondary: (s) => hang(s) });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0 })));
      await jest.advanceTimersByTimeAsync(4000);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error.reason).toBe("timeout");
    });

    test("0 + continue: resolves on defaults after one attempt", async () => {
      legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0, onInitFailure: "continue" })));
      await jest.advanceTimersByTimeAsync(50);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
      expect(log.logCount("warn", /onInitFailure=continue: STARTING ON CODE DEFAULTS/)).toBe(1);
    });

    test("0 + wait: keeps retrying and resolves once config arrives", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0, onInitFailure: "wait" })));
      await jest.advanceTimersByTimeAsync(3000);
      expect(init.settled).toBe(false);
      expect(net.calls).toBeGreaterThan(2);
      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(10_000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
    });

    test("0 + fail: poll() started right after init() still applies the policy after one attempt", async () => {
      legs({
        primary: () => delayed(100, (_, reject) => reject(new TypeError("fetch failed"))),
        secondary: () => delayed(100, (_, reject) => reject(new TypeError("fetch failed"))),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0 })));
      q.poll({ frequencyInMs: 60_000 }).catch(() => {});
      await jest.advanceTimersByTimeAsync(1000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
    });

    test("0 + continue: poll() started right after init() still resolves on defaults", async () => {
      legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 0, onInitFailure: "continue" })));
      q.poll({ frequencyInMs: 60_000 }).catch(() => {});
      await jest.advanceTimersByTimeAsync(1000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
    });

    test("a non-finite initTimeout warns and falls back to the 5s default", async () => {
      legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: Number.NaN })));
      await jest.advanceTimersByTimeAsync(4900);
      expect(init.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(log.logCount("warn", /invalid initTimeout/)).toBe(1);
    });
  });

  describe("D4: no userinfo or upstream bodies in init logs or the init error", () => {
    const leaks = (text) =>
      [
        "user:pass",
        "s3cret",
        "eval-with-context",
        "portal-secret",
        "html-secret",
        "upstream body",
      ].filter((needle) => text.includes(needle));

    const allText = (err) =>
      [
        ...log.lines.map((l) => l.msg),
        err?.message ?? "",
        err?.cause instanceof Error ? err.cause.message : String(err?.cause ?? ""),
      ].join("\n");

    test("a fetch error that echoes the full URL (credentials, encoded context) is reduced to host + class", async () => {
      legs({
        primary: (_, url) =>
          Promise.reject(
            new TypeError(
              `Request cannot be constructed from a URL that includes credentials: ${String(
                url
              ).replace("https://", "https://user:pass@")}`
            )
          ),
        secondary: (_, url) =>
          Promise.reject(new TypeError(`Failed to fetch https://user:s3cret@x/${url}`)),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 1000 })));
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(leaks(allText(init.error))).toEqual([]);
      expect(init.error.message).toMatch(/primary=primary\.quonfig-staging\.com: /);
    });

    test("a 200 without evaluations and a non-JSON 200 never echo the body", async () => {
      legs({
        primary: () =>
          Promise.resolve(
            new Response(JSON.stringify({ captive: "portal-secret" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          ),
        secondary: () => Promise.resolve(new Response("<html>html-secret</html>", { status: 200 })),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 1000 })));
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(leaks(allText(init.error))).toEqual([]);
    });

    test("an HTTP failure is reported as 'HTTP <status>'", async () => {
      legs({
        primary: () => Promise.resolve(status(503)),
        secondary: () => Promise.resolve(status(502)),
      });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 1000 })));
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error.message).toMatch(
        /primary=primary\.quonfig-staging\.com: HTTP 503; secondary=secondary\.quonfig-staging\.com: HTTP 502/
      );
      expect(leaks(allText(init.error))).toEqual([]);
    });

    test("an apiUrl carrying userinfo is logged by host only", async () => {
      legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(
        q.init(
          opts({ apiUrls: ["https://user:pass@primary.quonfig-staging.com"], initTimeout: 1000 })
        )
      );
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      expect(leaks(allText(init.error))).toEqual([]);
    });
  });

  describe("stopPolling() never kills a pending init's retry loop", () => {
    test("wait: stopPolling() while init() is pending; init still heals and resolves", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ onInitFailure: "wait" })));
      await jest.advanceTimersByTimeAsync(1000);
      q.stopPolling();
      await jest.advanceTimersByTimeAsync(10_000);
      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(40_000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
      expect(q.get("feature")).toBe(true);
    });

    test("wait: poll() then stopPolling() while init() is pending; init still heals", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ onInitFailure: "wait" })));
      await jest.advanceTimersByTimeAsync(1000);
      q.poll({ frequencyInMs: 60_000 }).catch(() => {});
      await jest.advanceTimersByTimeAsync(100);
      q.stopPolling();
      await jest.advanceTimersByTimeAsync(1000);
      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(40_000);
      expect(init.settled).toBe(true);
      expect(init.error).toBeUndefined();
    });

    test("fail: stopPolling() after a caught failure keeps the background retry (no dead client)", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      const init = track(q.init(opts({ initTimeout: 1000 })));
      await jest.advanceTimersByTimeAsync(1100);
      expect(init.error).toBeInstanceOf(QuonfigInitError);
      q.stopPolling();
      net.handlers = { primary: up, secondary: up };
      await jest.advanceTimersByTimeAsync(40_000);
      expect(q.isReady()).toBe(true);
    });

    test("close() still stops the init retry", async () => {
      const net = legs({ primary: refused, secondary: refused });
      q = new Quonfig();
      track(q.init(opts({ onInitFailure: "wait" })));
      await jest.advanceTimersByTimeAsync(1000);
      await q.close();
      const calls = net.calls;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(net.calls).toBe(calls);
    });
  });
});
