/**
 * qfg-goi1.2.6 item 1: a failed poll tick must not be an unhandled promise
 * rejection. doPolling chained only `.finally` onto load(), so every tick
 * during an outage (no LKG entry) re-rejected with nothing attached. Node >=15
 * exits the process on the first one; browsers report each one to error
 * trackers at the poll frequency.
 */

const { Quonfig } = require("../dist/quonfig");

const okBody = () =>
  new Response(
    JSON.stringify({ evaluations: { feature: { value: { type: "bool", value: true } } } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("doPolling during an outage", () => {
  let originalFetch;
  let rejections;
  const trap = (reason) => rejections.push(reason);

  beforeEach(() => {
    originalFetch = global.fetch;
    rejections = [];
    process.on("unhandledRejection", trap);
  });

  afterEach(() => {
    process.off("unhandledRejection", trap);
    global.fetch = originalFetch;
  });

  test("failed ticks produce no unhandled rejections, warn once per outage, and keep polling", async () => {
    let down = false;
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (down) throw new Error("fetch failed");
      return okBody();
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      apiUrls: ["https://primary.quonfig-staging.com"],
      collectEvaluationSummaries: false,
    });
    warn.mockClear();

    await q.poll({ frequencyInMs: 50 });
    down = true;
    const callsAtOutage = calls;
    await sleep(500);
    q.stopPolling();
    await sleep(20);

    const outageWarnings = warn.mock.calls.filter((c) => /poll/i.test(String(c[0])));
    warn.mockRestore();

    expect(calls - callsAtOutage).toBeGreaterThanOrEqual(5); // the loop kept ticking
    expect(rejections).toHaveLength(0);
    expect(outageWarnings).toHaveLength(1); // once per outage, not once per tick
    expect(q.get("feature")).toBe(true); // last good config still served
  });
});
