/**
 * qfg-goi1.10.29: auth-failure rule for the browser SDK (plan
 * project/plans/2026-10-07-sdk-auth-failure-rule.md section 4, frontend scope
 * R1, R2 polling-mode entry, R3, R4, R5).
 *
 * A 401/403/404/410 on a config fetch leg is the auth class. One poll cycle in
 * which no leg returned 200/304 and the primary returned an auth-class status
 * enters auth-failed: one config ERROR (status + host, never the key), then
 * each next poll waits max(T, frequencyInMs), T uniform in [150s, 300s],
 * re-drawn every time, no doubling, never stops. The first 200/304 on any leg
 * exits with one INFO and polling resumes at frequencyInMs. Primary 503 +
 * secondary 401 is transient handling and does not enter.
 *
 * The fetch mock plays both legs and answers every request from a per-host
 * script, and jest's fake clock stands in for wall time: the gap between two
 * primary hits is the wait the poll loop asked for.
 */

const { Quonfig } = require("../dist/quonfig");

const SDK_KEY = "qf_pk_development_secret_key_value";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";
const FREQ = 60_000;

function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const okResponse = (generation) =>
  new Response(
    JSON.stringify({
      evaluations: { feature: { value: { type: "bool", value: true } } },
      meta: { version: `gen-${generation}`, environment: "Production", generation },
    }),
    { status: 200, headers: { "Content-Type": "application/json", ETag: `"g${generation}"` } }
  );

const statusResponse = (status) => new Response(null, { status, statusText: `status ${status}` });

// Each leg answers with the status in `script[leg]` (200 = a valid envelope,
// 304 = not modified, anything else = that error status). Every hit is logged
// with the fake clock's time.
function legFetch(script) {
  const hits = [];
  let generation = 1;
  global.fetch = jest.fn(async (url) => {
    const leg = url.startsWith(PRIMARY) ? "primary" : "secondary";
    hits.push({ leg, at: Date.now() });
    const status = script[leg];
    if (status === 200) return okResponse(generation++);
    return statusResponse(status);
  });
  return hits;
}

// Gaps between primary hits after `from` (itself a primary hit time).
const primaryGaps = (hits, from) => {
  const times = [from, ...hits.filter((h) => h.leg === "primary" && h.at > from).map((h) => h.at)];
  return times.slice(1).map((t, i) => t - times[i]);
};

const configErrors = (spy) =>
  spy.mock.calls.filter((c) => /config fetch rejected/.test(String(c[0])));
const exitInfos = (spy) => spy.mock.calls.filter((c) => /config fetch accepted/.test(String(c[0])));

describe.each([
  ["without a last-known-good entry", false],
  ["with a last-known-good entry", true],
])("auth-failure rule (%s)", (_label, withLkg) => {
  let originalFetch;
  let errorSpy;
  let warnSpy;
  let infoSpy;
  let debugSpy;
  let randomSpy;
  let q;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    originalFetch = global.fetch;
    if (withLkg) global.localStorage = fakeLocalStorage();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
    // T = 150s + 0.5 * 150s = 225s.
    randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    q?.stopPolling();
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete global.localStorage;
    jest.restoreAllMocks();
  });

  // init succeeds (valid key, writes LKG when localStorage exists), then
  // polling starts at FREQ. The first poll fetch fires immediately.
  async function startPolling(script, frequencyInMs = FREQ) {
    const hits = legFetch(script);
    q = new Quonfig();
    await q.init({
      sdkKey: SDK_KEY,
      context: { user: { key: "alice" } },
      apiUrls: [PRIMARY, SECONDARY],
      hedgeDelay: 40,
      timeout: 1000,
      collectEvaluationSummaries: false,
    });
    await q.poll({ frequencyInMs });
    return hits;
  }

  test.each([401, 403, 404, 410])(
    "%i on every leg: one cycle enters, one ERROR, slow probes forever, secondary 200 exits",
    async (status) => {
      const script = { primary: 200, secondary: 200 };
      const hits = await startPolling(script);

      script.primary = status;
      script.secondary = status;
      const outageStart = Date.now();
      // ONE failed poll cycle.
      await jest.advanceTimersByTimeAsync(FREQ);
      expect(configErrors(errorSpy)).toHaveLength(1);
      const msg = String(configErrors(errorSpy)[0][0]);
      expect(msg).toContain(String(status));
      expect(msg).toContain("primary.quonfig-staging.com");
      expect(msg).not.toContain(SDK_KEY);

      // Six probes at T = 225s each: no doubling, no stop, no more ERRORs.
      await jest.advanceTimersByTimeAsync(6 * 225_000);
      const gaps = primaryGaps(hits, outageStart);
      // The entering cycle is the normal tick; then six probes.
      expect(gaps).toEqual([FREQ, 225_000, 225_000, 225_000, 225_000, 225_000, 225_000]);
      expect(configErrors(errorSpy)).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      // The poll-outage WARN is replaced by the config ERROR.
      expect(warnSpy.mock.calls.filter((c) => /poll failed/.test(String(c[0])))).toHaveLength(0);
      // Every probe after entry is rejected and logs at DEBUG.
      expect(debugSpy.mock.calls.filter((c) => /auth-failed/.test(String(c[0]))).length).toBe(6);
      expect(q.get("feature")).toBe(true); // last good config still served

      // A secondary-only 200 exits.
      script.secondary = 200;
      await jest.advanceTimersByTimeAsync(225_000);
      expect(exitInfos(infoSpy)).toHaveLength(1);

      // Polling resumes at FREQ.
      const exitAt = Date.now();
      await jest.advanceTimersByTimeAsync(3 * FREQ);
      expect(primaryGaps(hits, exitAt)).toEqual([FREQ, FREQ, FREQ]);
      expect(exitInfos(infoSpy)).toHaveLength(1);
      expect(configErrors(errorSpy)).toHaveLength(1);
    }
  );

  test("T is re-drawn per probe from [150s, 300s]", async () => {
    const script = { primary: 200, secondary: 200 };
    const hits = await startPolling(script);
    script.primary = 401;
    script.secondary = 401;
    const outageStart = Date.now();
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.999999).mockReturnValueOnce(0.2);
    await jest.advanceTimersByTimeAsync(FREQ); // enters, draws 0 -> 150s
    await jest.advanceTimersByTimeAsync(150_000); // probe, draws ~300s
    await jest.advanceTimersByTimeAsync(300_000); // probe, draws 0.2 -> 180s
    await jest.advanceTimersByTimeAsync(180_000);
    const gaps = primaryGaps(hits, outageStart);
    expect(gaps[0]).toBe(FREQ); // the entering tick
    expect(gaps[1]).toBe(150_000);
    expect(gaps[2]).toBeGreaterThan(299_000);
    expect(gaps[2]).toBeLessThanOrEqual(300_000);
    expect(gaps[3]).toBe(180_000);
  });

  test("polling mode waits max(T, frequencyInMs)", async () => {
    const freq = 400_000;
    const script = { primary: 200, secondary: 200 };
    const hits = await startPolling(script, freq);
    script.primary = 410;
    script.secondary = 410;
    const outageStart = Date.now();
    await jest.advanceTimersByTimeAsync(freq * 4);
    expect(configErrors(errorSpy)).toHaveLength(1);
    expect(primaryGaps(hits, outageStart)).toEqual([freq, freq, freq, freq]);
  });

  test("primary 401 + secondary 503 enters", async () => {
    const script = { primary: 200, secondary: 200 };
    const hits = await startPolling(script);
    script.primary = 401;
    script.secondary = 503;
    const outageStart = Date.now();
    await jest.advanceTimersByTimeAsync(FREQ + 2 * 225_000);
    expect(configErrors(errorSpy)).toHaveLength(1);
    expect(primaryGaps(hits, outageStart)).toEqual([FREQ, 225_000, 225_000]);
  });

  test("primary 503 + secondary 401 does not enter", async () => {
    const script = { primary: 200, secondary: 200 };
    const hits = await startPolling(script);
    script.primary = 503;
    script.secondary = 401;
    const outageStart = Date.now();
    await jest.advanceTimersByTimeAsync(5 * FREQ);
    expect(configErrors(errorSpy)).toHaveLength(0);
    expect(primaryGaps(hits, outageStart)).toEqual([FREQ, FREQ, FREQ, FREQ, FREQ]);
  });

  test("a 304 on the primary exits, and a later rejected cycle enters again (no latch)", async () => {
    const script = { primary: 200, secondary: 200 };
    await startPolling(script);
    script.primary = 401;
    script.secondary = 401;
    await jest.advanceTimersByTimeAsync(FREQ);
    expect(configErrors(errorSpy)).toHaveLength(1);

    // The primary's cached ETag makes the next request conditional.
    script.primary = 304;
    await jest.advanceTimersByTimeAsync(225_000);
    expect(exitInfos(infoSpy)).toHaveLength(1);

    script.primary = 401;
    await jest.advanceTimersByTimeAsync(FREQ);
    expect(configErrors(errorSpy)).toHaveLength(2);
  });

  test("init and updateContext never enter", async () => {
    const script = { primary: 200, secondary: 200 };
    await startPolling(script);
    q.stopPolling();
    script.primary = 401;
    script.secondary = 401;
    await q.updateContext({ user: { key: "bob" } }).catch(() => {});
    await jest.advanceTimersByTimeAsync(10 * FREQ);
    expect(configErrors(errorSpy)).toHaveLength(0);
  });
});
