/**
 * qfg-iikt: sdk-javascript sends If-None-Match / honors ETag on the
 * eval-with-context poll (304 fast-path).
 *
 * Server contract (api-delivery eval_context.go): ETag = first 16 bytes of
 * sha256(version \0 contextToken), hex-encoded (32 hex chars). It folds in BOTH
 * the workspace version AND the context, so a 304 fires only when both are
 * unchanged. The client keys its stored ETag by the FULL request URL (which
 * embeds the encoded context) so a context switch can never replay a stale
 * ETag minted for a different context.
 */

const Loader = require("../dist/loader").default;
const { Quonfig } = require("../dist/quonfig");

const ETAG_A = "0123456789abcdef0123456789abcdef"; // 32 hex chars
const ETAG_B = "fedcba9876543210fedcba9876543210";

// Build a fetch mock that plays back a queue of scripted responses and records
// every (url, init) it was called with so tests can assert on If-None-Match.
function scriptedFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = jest.fn(async (url, init) => {
    calls.push({ url, headers: { ...(init && init.headers) } });
    const next = queue.shift();
    if (!next) throw new Error(`fetch called more times than scripted: ${url}`);
    return next();
  });
  fn.calls = calls;
  return fn;
}

const ok = (body, etag) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: etag
      ? { "Content-Type": "application/json", ETag: etag }
      : { "Content-Type": "application/json" },
  });

const notModified = () => () => new Response(null, { status: 304 });

const baseParams = {
  sdkKey: "qf_pk_development_test",
  contexts: { user: { key: "alice" } },
  apiUrls: ["https://primary.quonfig-staging.com"],
  clientVersion: "javascript-test",
};

describe("Loader ETag / 304 fast-path", () => {
  let originalFetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("first load sends NO If-None-Match and stores the ETag from the 200", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: { flagA: { value: { bool: true } } } }, ETAG_A),
    ]);

    const loader = new Loader({ ...baseParams });
    const result = await loader.load();

    expect(result.notModified).toBe(false);
    expect(result.payload.evaluations.flagA).toBeDefined();
    // No conditional header on the very first request.
    expect(global.fetch.calls[0].headers["If-None-Match"]).toBeUndefined();
  });

  test("second identical-context poll sends If-None-Match and a 304 keeps cache (notModified)", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: { flagA: { value: { bool: true } } } }, ETAG_A),
      notModified(),
    ]);

    const loader = new Loader({ ...baseParams });
    await loader.load();
    const second = await loader.load();

    expect(second.notModified).toBe(true);
    expect(second.payload).toBeUndefined();
    // The second request revalidated with the ETag from the first 200.
    expect(global.fetch.calls[1].headers["If-None-Match"]).toBe(ETAG_A);
  });

  test("a fresh 200 after a 304 swaps in the new payload and rotates the ETag", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: { flagA: { value: { bool: true } } } }, ETAG_A),
      notModified(),
      ok({ evaluations: { flagA: { value: { bool: false } } } }, ETAG_B),
      notModified(),
    ]);

    const loader = new Loader({ ...baseParams });
    await loader.load(); // 200 -> ETAG_A
    await loader.load(); // 304
    const third = await loader.load(); // 200 -> ETAG_B
    const fourth = await loader.load(); // 304 (against ETAG_B)

    expect(third.notModified).toBe(false);
    expect(third.payload.evaluations.flagA.value.bool).toBe(false);
    expect(global.fetch.calls[2].headers["If-None-Match"]).toBe(ETAG_A);
    // After the new 200, revalidation must use the ROTATED etag, not the stale one.
    expect(fourth.notModified).toBe(true);
    expect(global.fetch.calls[3].headers["If-None-Match"]).toBe(ETAG_B);
  });

  test("a context change does NOT replay the stale ETag (different URL → fresh 200)", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: { flagA: { value: { bool: true } } } }, ETAG_A),
      // Context B: server would mint a different etag; the client must not send A's.
      ok({ evaluations: { flagA: { value: { bool: false } } } }, ETAG_B),
    ]);

    const loader = new Loader({ ...baseParams });
    await loader.load(); // context alice -> ETAG_A

    // Simulate updateContext(): quonfig.ts sets loader.contexts before load().
    loader.contexts = { user: { key: "bob" } };
    const result = await loader.load();

    expect(result.notModified).toBe(false);
    expect(result.payload.evaluations.flagA.value.bool).toBe(false);
    // Crucially: the second (different-context) request carried NO If-None-Match.
    expect(global.fetch.calls[1].headers["If-None-Match"]).toBeUndefined();
  });

  test("alternating contexts each keep their own ETag (per-URL, both can 304)", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: {} }, ETAG_A), // alice -> ETAG_A
      ok({ evaluations: {} }, ETAG_B), // bob   -> ETAG_B
      notModified(), // alice again — revalidates with ETAG_A
      notModified(), // bob again   — revalidates with ETAG_B
    ]);

    const loader = new Loader({ ...baseParams });
    await loader.load(); // alice
    loader.contexts = { user: { key: "bob" } };
    await loader.load(); // bob
    loader.contexts = { user: { key: "alice" } };
    const aliceAgain = await loader.load();
    loader.contexts = { user: { key: "bob" } };
    const bobAgain = await loader.load();

    // Each context sends ITS OWN etag (never the other's), and both 304.
    expect(global.fetch.calls[2].headers["If-None-Match"]).toBe(ETAG_A);
    expect(global.fetch.calls[3].headers["If-None-Match"]).toBe(ETAG_B);
    expect(aliceAgain.notModified).toBe(true);
    expect(bobAgain.notModified).toBe(true);
  });

  test("ETag cache is bounded — oldest URL is evicted past the LRU cap (no stale send)", async () => {
    originalFetch = global.fetch;
    // 18 distinct contexts (cap is 16): first context's etag must be evicted by
    // the time we revisit it, so the revisit is a plain GET, never a stale 304.
    const responses = [];
    for (let i = 0; i < 18; i++) responses.push(ok({ evaluations: {} }, ETAG_A));
    responses.push(ok({ evaluations: {} }, ETAG_B)); // revisit context #0
    global.fetch = scriptedFetch(responses);

    const loader = new Loader({ ...baseParams });
    for (let i = 0; i < 18; i++) {
      loader.contexts = { user: { key: `u${i}` } };
      await loader.load();
    }
    // Revisit the very first context — its etag was pushed out of the LRU.
    loader.contexts = { user: { key: "u0" } };
    await loader.load();

    expect(global.fetch.calls[18].headers["If-None-Match"]).toBeUndefined();
  });

  test("a 200 without an ETag header forgets any prior etag (stops revalidating)", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: {} }, ETAG_A),
      ok({ evaluations: {} }, undefined), // server stopped sending ETag
      ok({ evaluations: {} }, undefined),
    ]);

    const loader = new Loader({ ...baseParams });
    await loader.load();
    await loader.load(); // sends ETAG_A, gets 200 w/o etag -> forget it
    await loader.load();

    expect(global.fetch.calls[1].headers["If-None-Match"]).toBe(ETAG_A);
    expect(global.fetch.calls[2].headers["If-None-Match"]).toBeUndefined();
  });
});

describe("Quonfig — 304 retains the previously evaluated config (anti-stale)", () => {
  let originalFetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("init 200 → poll 304 keeps values; → poll 200 swaps them", async () => {
    originalFetch = global.fetch;
    global.fetch = scriptedFetch([
      ok({ evaluations: { feature: { value: { type: "bool", value: true } } } }, ETAG_A), // init
      notModified(), // poll #1 — must KEEP feature=true
      ok({ evaluations: { feature: { value: { type: "bool", value: false } } } }, ETAG_B), // poll #2 — swap to false
    ]);

    const q = new Quonfig();
    await q.init({
      sdkKey: "qf_pk_development_test",
      context: { user: { key: "alice" } },
      apiUrls: ["https://primary.quonfig-staging.com"],
      collectEvaluationSummaries: false,
    });
    expect(q.get("feature")).toBe(true);

    // Drive load() directly (poll() would attach timers). load() is private,
    // so go through updateContext with the SAME context to trigger a re-fetch.
    await q.updateContext({ user: { key: "alice" } });
    expect(q.get("feature")).toBe(true); // 304 -> unchanged, NOT undefined/stale-cleared

    await q.updateContext({ user: { key: "alice" } });
    expect(q.get("feature")).toBe(false); // fresh 200 applied
  });
});
