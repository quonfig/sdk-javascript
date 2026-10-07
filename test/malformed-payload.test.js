/**
 * qfg-goi1.2.6 item 2: one malformed evaluation must not hang init() or wedge
 * polling.
 *
 * Config.digest threw for the whole payload on a single bad entry (a json
 * value sent as a string, or an evaluation with a null value). The throw ran
 * inside the loader's onResult, after sawSuccess was already set, so the
 * hedged load never settled: init() stayed pending forever and the poll loop
 * stopped while pollStatus still said "running".
 *
 * Fix: (a) a bad entry decodes to a Config with coercionError set (the
 * existing duration path), so get() returns undefined and getDetails reports
 * ERROR / TYPE_MISMATCH while the other flags load; (b) the loader sets
 * sawSuccess only after onResult returns, so a throwing install counts as a
 * failed leg and the load always settles.
 */

const { Quonfig } = require("../dist/quonfig");
const Loader = require("../dist/loader").default;

const body = (evaluations) =>
  new Response(JSON.stringify({ evaluations }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const GOOD = { "good.flag": { value: { type: "bool", value: true } } };
const STRINGIFIED_JSON = { ...GOOD, "bad.json": { value: { type: "json", value: '{"a":1}' } } };
const NULL_VALUE = { ...GOOD, "bad.null": { value: null } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (promise, ms) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected"
    ),
    sleep(ms).then(() => "pending"),
  ]);

const initOptions = {
  sdkKey: "qf_pk_development_test",
  context: { user: { key: "alice" } },
  apiUrls: ["https://primary.quonfig-staging.com"],
  collectEvaluationSummaries: false,
};

describe("malformed evaluation payloads", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a stringified json value: init resolves, other flags load, the bad key reports ERROR", async () => {
    global.fetch = jest.fn(async () => body(STRINGIFIED_JSON));
    const q = new Quonfig();
    expect(await within(q.init(initOptions), 1000)).toBe("resolved");
    expect(q.isEnabled("good.flag")).toBe(true);
    expect(q.get("bad.json")).toBeUndefined();
    const details = q.getDetails("bad.json");
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("TYPE_MISMATCH");
    expect(details.errorMessage).not.toContain('{"a":1}');
  });

  test("a null evaluation value: init resolves, other flags load, the bad key reports ERROR", async () => {
    global.fetch = jest.fn(async () => body(NULL_VALUE));
    const q = new Quonfig();
    expect(await within(q.init(initOptions), 1000)).toBe("resolved");
    expect(q.isEnabled("good.flag")).toBe(true);
    expect(q.getDetails("bad.null").reason).toBe("ERROR");
  });

  test("one bad poll tick does not wedge polling", async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      return calls === 2 ? body(STRINGIFIED_JSON) : body(GOOD);
    });
    const q = new Quonfig();
    await q.init(initOptions);
    q.poll({ frequencyInMs: 50 }).catch(() => {});
    await sleep(500);
    q.stopPolling();
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  test("the loader settles when onResult throws (the leg counts as failed)", async () => {
    global.fetch = jest.fn(async () => body(GOOD));
    const loader = new Loader({
      sdkKey: "qf_pk_development_test",
      contexts: { user: { key: "alice" } },
      apiUrls: ["https://primary.quonfig-staging.com"],
    });
    const outcome = await within(
      loader.loadHedged(() => {
        throw new Error("install failed");
      }),
      1000
    );
    expect(outcome).toBe("rejected");
  });
});
