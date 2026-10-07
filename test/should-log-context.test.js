/**
 * qfg-goi1.2.6 item 10: shouldLog({loggerPath}) must not change the context
 * the SDK fetches with.
 *
 * It used to add `quonfig-sdk-logging: {key: loggerPath}` to the live client
 * context. Every later fetch then carried it: the evaluation inputs changed,
 * the next load had a new context signature and was treated as a context
 * switch, which skips the reject-older guard, so an older generation (a
 * lagging secondary) could replace a newer one. The browser evaluates
 * server-side once per fetched context, so the logger path cannot select
 * per-logger rules anyway.
 */

const { Quonfig, QUONFIG_SDK_LOGGING_CONTEXT_NAME } = require("../dist");

const ALICE = { user: { key: "alice" } };

const genBody = (generation, level) =>
  new Response(
    JSON.stringify({
      evaluations: {
        "log-level.app": { value: { type: "log_level", value: level } },
      },
      meta: { version: `gen-${generation}`, environment: "Production", generation },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const decodeContextFromUrl = (url) => {
  const segment = new URL(url).pathname.split("/").pop();
  return JSON.parse(Buffer.from(decodeURIComponent(segment), "base64").toString("utf8"));
};

describe("shouldLog({loggerPath}) leaves the fetch context alone", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const initedClient = async (fetchImpl) => {
    global.fetch = fetchImpl;
    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: ALICE,
      apiUrls: ["https://primary.quonfig-staging.com"],
      loggerKey: "log-level.app",
      collectEvaluationSummaries: false,
    });
    return q;
  };

  test("the client context and the next fetch carry no logging context", async () => {
    const urls = [];
    const q = await initedClient(
      jest.fn(async (url) => {
        urls.push(url);
        return genBody(10, "DEBUG");
      })
    );

    expect(q.shouldLog({ loggerPath: "checkout.cart", desiredLevel: "debug" })).toBe(true);
    expect(q.contexts).toEqual(ALICE);
    expect(q.contexts[QUONFIG_SDK_LOGGING_CONTEXT_NAME]).toBeUndefined();

    await q.updateContext(q.contexts);
    expect(decodeContextFromUrl(urls[urls.length - 1])).toEqual(ALICE);
  });

  test("a later load still runs through the reject-older guard", async () => {
    let generation = 10;
    const q = await initedClient(
      jest.fn(async () => genBody(generation, generation === 10 ? "DEBUG" : "ERROR"))
    );
    expect(q.heldGeneration).toBe(10);

    q.shouldLog({ loggerPath: "checkout.cart", desiredLevel: "debug" });

    // A lagging leg answers with an older generation.
    generation = 4;
    await q.load();
    expect(q.heldGeneration).toBe(10);
    expect(q.shouldLog({ loggerPath: "checkout.cart", desiredLevel: "debug" })).toBe(true);
  });
});
