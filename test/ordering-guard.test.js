/**
 * qfg-7h5d.2.1 — reject-older install guard (spec 5f / 5f.1).
 *
 * sdk-javascript installed every fetched payload UNCONDITIONALLY, and the only
 * version field on the wire was an unordered commit SHA. With the parallel
 * hedge (5e) live, any primary response slower than the hedge delay — or a
 * failover to the depth-1 secondary, which stamps generation=1 for everything —
 * would overwrite fresher held data with an up-to-60s-stale payload, then the
 * next fast primary poll would flip it forward again: flag oscillation on a
 * healthy client.
 *
 * The fix consumes the monotonic Meta.generation the backend already emits
 * (eval_context.go sets it) and guards every NETWORK install path with the
 * canonical reject-older rule (mirrors sdk-node/src/quonfig.ts:1251):
 *
 *   - fresh client (nothing installed) installs anything
 *   - incoming generation <= 0 (absent / pre-watermark / depth-1 secondary)
 *     installs anyway — the carve-out; an unversioned payload carries no
 *     ordering info so it cannot be rejected as "older"
 *   - otherwise install iff incoming generation strictly exceeds the held one;
 *     equal or lower is a no-op (no regress, no flap)
 *
 * A context switch is a different query whose generation is not comparable to
 * the held one, so it always installs (the "fresh for this context" case).
 */

const { Quonfig } = require("../dist/quonfig");

const ALICE = { user: { key: "alice" } };
const BOB = { user: { key: "bob" } };

// Build a fetch mock that plays back a queue of scripted responses.
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

// A 200 carrying an evaluations payload + a Meta.generation watermark. Each
// response gets a DISTINCT ETag (derived from generation+value) so the loader's
// per-URL If-None-Match never collapses a scripted 200 into a 304 and masks the
// install path under test — same precaution as sdk-go's ordering_guard_test.go.
const okGen = (generation, value) => () =>
  new Response(
    JSON.stringify({
      evaluations: { feature: { value: { type: "bool", value } } },
      meta: { version: `gen-${generation}`, environment: "Production", generation },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: `"gen-${generation}-${value}"` },
    }
  );

// A 200 with NO meta block at all (a server that predates the watermark): the
// SDK must treat the absent generation as the gen<=0 carve-out, not freeze.
const okUnversioned = (value) => () =>
  new Response(JSON.stringify({ evaluations: { feature: { value: { type: "bool", value } } } }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: `"unversioned-${value}"` },
  });

async function newClient(firstResponseFactory) {
  global.fetch = scriptedFetch([firstResponseFactory]);
  const q = new Quonfig();
  await q.init({
    sdkKey: "qf_pk_development_test",
    context: ALICE,
    apiUrls: ["https://primary.quonfig-staging.com"],
    collectEvaluationSummaries: false,
  });
  return q;
}

// Trigger one re-fetch. updateContext drives the same load() path the poller
// uses; passing the SAME context keeps `_loadedContextSig` equal so the
// reject-older guard (not the context-switch bypass) is what's under test. We
// swap in a fresh single-shot mock per refresh so each call serves exactly one
// scripted response; the loader's own per-URL ETag cache persists across them,
// and the distinct ETags keep every scripted 200 a real 200 (never a 304).
async function refresh(q, responseFactory, context = ALICE) {
  global.fetch = scriptedFetch([responseFactory]);
  await q.updateContext(context);
}

describe("reject-older install guard (5f)", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("fresh client seeds off whatever arrives first, even the gen=1 secondary floor", async () => {
    const q = await newClient(okGen(1, true));
    expect(q.get("feature")).toBe(true);
    expect(q.heldGeneration).toBe(1);
  });

  test("reject-older: a failover to an OLDER generation never regresses an established client", async () => {
    const q = await newClient(okGen(42, true));
    expect(q.get("feature")).toBe(true);
    const installs = q.dataVersion;

    // Primary is "down"; this refresh fails over to the secondary's older gen 41.
    await refresh(q, okGen(41, false));

    // Behavioral signal (fails red on the unguarded code, which installs gen 41):
    expect(q.get("feature")).toBe(true); // STILL gen 42's value — gen 41 dropped
    expect(q.dataVersion).toBe(installs); // no install happened
    expect(q.heldGeneration).toBe(42);
  });

  test("same-generation refresh is a no-op (no flap, no second install)", async () => {
    const q = await newClient(okGen(42, true));
    const installs = q.dataVersion;

    // Same generation, different value (artificial — same gen means same content
    // on a real server). The guard must treat equal-not-greater as a no-op.
    await refresh(q, okGen(42, false));

    // Behavioral signal (fails red on the unguarded code, which re-installs):
    expect(q.get("feature")).toBe(true);
    expect(q.dataVersion).toBe(installs);
    expect(q.heldGeneration).toBe(42);
  });

  test("heal-forward: a newer generation installs and advances the watermark", async () => {
    const q = await newClient(okGen(41, true));
    expect(q.get("feature")).toBe(true);
    expect(q.heldGeneration).toBe(41);

    await refresh(q, okGen(42, false));

    expect(q.get("feature")).toBe(false);
    expect(q.heldGeneration).toBe(42);
  });

  test("carve-out: an established client installs a gen<=0 (unversioned) payload, not freeze", async () => {
    const q = await newClient(okGen(42, true));
    expect(q.heldGeneration).toBe(42);

    // Server now serves generation 0 (a pre-watermark deploy / rev-count fallback).
    await refresh(q, okGen(0, false));
    expect(q.get("feature")).toBe(false); // installed despite 0 < 42 (carve-out)
    expect(q.heldGeneration).toBe(0);
  });

  test("carve-out: a payload with NO meta block at all still installs (pre-watermark server)", async () => {
    const q = await newClient(okGen(42, true));
    await refresh(q, okUnversioned(false));
    expect(q.get("feature")).toBe(false);
    expect(q.heldGeneration).toBe(0);
  });

  test("context switch always installs, even to a lower generation (fresh-for-context)", async () => {
    const q = await newClient(okGen(42, true));
    expect(q.heldGeneration).toBe(42);

    // Switch context to bob; during an outage only the gen=1 secondary answers.
    // A context switch is a new query — it must install (the guard must NOT
    // strand updateContext on the held generation).
    await refresh(q, okGen(1, false), BOB);
    expect(q.get("feature")).toBe(false);
    expect(q.heldGeneration).toBe(1);
  });
});
