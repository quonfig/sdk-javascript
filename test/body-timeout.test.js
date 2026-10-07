/**
 * qfg-goi1.2.6 item 3: the per-leg fetch deadline must cover the body read.
 *
 * The loader cleared its timeout and dropped the leg's AbortController as soon
 * as response headers arrived, so response.json() had no deadline and could not
 * be superseded. A server (or proxy) that sends headers and then stalls the
 * body hung init() forever.
 */

const { Quonfig } = require("../dist/quonfig");

// Headers arrive immediately; the body never finishes unless the request's
// AbortSignal fires, which errors the stream like a real fetch would.
const stalledBodyFetch = (aborts) =>
  jest.fn(async (_url, { signal }) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"evaluations":'));
        signal.addEventListener("abort", () => {
          aborts.push(Date.now());
          controller.error(new DOMException("This operation was aborted", "AbortError"));
        });
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("fetch deadline covers the body", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a stalled body is aborted at the leg timeout and init settles", async () => {
    const aborts = [];
    global.fetch = stalledBodyFetch(aborts);
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const q = new Quonfig();
    const started = Date.now();
    const outcome = Promise.race([
      q
        .init({
          sdkKey: "qf_pk_development_test",
          context: { user: { key: "alice" } },
          apiUrls: ["https://only.quonfig-staging.com"],
          timeout: 300,
          hedgeDelay: 50,
          collectEvaluationSummaries: false,
        })
        .then(
          () => "resolved",
          () => "rejected"
        ),
      sleep(2000).then(() => "pending"),
    ]);

    expect(await outcome).toBe("rejected");
    expect(aborts).toHaveLength(1);
    expect(aborts[0] - started).toBeLessThan(1000);
    console.warn.mockRestore();
  });
});
