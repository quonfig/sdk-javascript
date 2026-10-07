/**
 * qfg-goi1.2.6 item 4: close() (or stopPolling()) during the first poll()
 * fetch must not restart polling. poll()'s `.finally` called doPolling()
 * unconditionally, which flipped the status back to "running" and scheduled
 * ticks nothing could stop (React StrictMode mount/unmount, test teardown).
 */

const { Quonfig } = require("../dist/quonfig");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okBody = () =>
  new Response(
    JSON.stringify({ evaluations: { feature: { value: { type: "bool", value: true } } } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

describe("stopping during the first poll fetch", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const initedClient = async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      await sleep(50);
      return okBody();
    });
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      apiUrls: ["https://primary.quonfig-staging.com"],
      collectEvaluationSummaries: false,
    });
    return { q, calls: () => calls };
  };

  test("close() before the first poll fetch settles leaves polling stopped", async () => {
    const { q, calls } = await initedClient();
    const first = q.poll({ frequencyInMs: 100 });
    await q.close();
    const callsAtClose = calls();
    await first;
    await sleep(600);
    expect(q.pollStatus).toEqual({ status: "stopped" });
    expect(calls() - callsAtClose).toBe(0);
  });

  test("a second poll() replaces the first: only one loop runs", async () => {
    const { q, calls } = await initedClient();
    const first = q.poll({ frequencyInMs: 100 });
    const second = q.poll({ frequencyInMs: 100 });
    await Promise.allSettled([first, second]);
    const start = calls();
    await sleep(550);
    q.stopPolling();
    // One loop at 100ms + a 50ms fetch is ~1 tick per 150ms: about 3-4 ticks.
    // Two loops would double that.
    expect(calls() - start).toBeLessThanOrEqual(5);
  });
});
