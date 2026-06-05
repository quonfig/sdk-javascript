/**
 * qfg-8uw5: poll() must start (and self-heal) its polling loop even when the
 * VERY FIRST poll fetch rejects.
 *
 * Regression history: the legacy ReforgeHQ SDK scheduled doPolling() in a
 * `.finally`, so a failed bootstrap fetch still started the loop. The Quonfig
 * port moved loop-scheduling into the success-only `.then`, so a single
 * startup-time network blip (both primary AND secondary unreachable on tick
 * one) left polling permanently dead — the client served whatever config it had
 * forever, with no self-heal even after connectivity returned. This is the
 * browser worst case (a page started on a flaky mobile/wifi connection).
 */

const { Quonfig } = require("../dist/quonfig");

const okBody = (value) =>
  new Response(JSON.stringify({ evaluations: { feature: { value: { type: "bool", value } } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const CONTEXT = { user: { key: "alice" } };

async function initedClient() {
  const q = new Quonfig();
  await q.init({
    sdkKey: "qf_pk_development_test",
    context: CONTEXT,
    apiUrls: ["https://primary.quonfig-staging.com"],
    collectEvaluationSummaries: false,
  });
  return q;
}

describe("poll() bootstrap resilience (qfg-8uw5)", () => {
  let originalFetch;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test("first poll fetch rejecting still starts the loop, which then self-heals", async () => {
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) return okBody(false); // init() succeeds → feature=false
      if (call === 2) throw new Error("network down"); // first poll fetch FAILS
      return okBody(true); // recovery on the next poll tick
    });

    const q = await initedClient();
    expect(q.get("feature")).toBe(false); // init applied

    // poll() may still reject on the first-fetch failure (legacy did too) — the
    // contract that matters is that the LOOP is scheduled regardless. Swallow
    // the expected rejection so it isn't an unhandled rejection.
    const pending = q.poll({ frequencyInMs: 1000 });
    pending.catch(() => {});

    // Flush the failed first poll fetch + the `.finally` that schedules doPolling.
    await jest.advanceTimersByTimeAsync(0);

    // THE REGRESSION ASSERTION: despite the first poll fetch rejecting, the loop
    // is scheduled. Pre-fix this stays "pending" forever (doPolling was only
    // reachable through the resolved `.then`).
    expect(q.pollStatus.status).toBe("running");
    expect(call).toBe(2);
    expect(q.get("feature")).toBe(false); // unchanged — the failed fetch applied nothing

    // Next tick fires the recovered fetch and applies fresh config — proving the
    // loop is genuinely alive and self-healing, not just flagged "running".
    await jest.advanceTimersByTimeAsync(1000);
    expect(call).toBe(3);
    expect(q.get("feature")).toBe(true);

    q.stopPolling();
  });

  test("steady-state: first poll fetch succeeding behaves as before", async () => {
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      return okBody(call >= 2); // init → false, polls → true
    });

    const q = await initedClient();
    await q.poll({ frequencyInMs: 1000 });

    expect(q.pollStatus.status).toBe("running");
    expect(q.get("feature")).toBe(true);

    q.stopPolling();
  });
});
