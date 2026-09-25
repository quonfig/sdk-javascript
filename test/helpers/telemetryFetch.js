/**
 * Scripted `fetch` mock for the telemetry transport contract tests
 * (integration-test-data/chaos/telemetry-transport-contract.md, browser subset).
 *
 * No sockets: every telemetry POST is recorded (url, options, raw body) and
 * answered from a script. A step is one of:
 *   { status: 200 }                       answer with that status
 *   { status: 429, retryAfter: "120" }    ... plus a Retry-After header
 *   { hang: true }                        never answer until release(i, step)
 *                                         or the request's AbortSignal fires
 *   { networkError: true }                reject like a browser network failure
 * Non-telemetry calls (the eval fetch at init) answer 200 with no evaluations.
 */
const crypto = require("crypto");

function makeResponse(step) {
  const headers = { "Content-Type": "application/json" };
  if (step.retryAfter !== undefined) headers["Retry-After"] = step.retryAfter;
  const body = step.status === 204 ? null : (step.body ?? "{}");
  return new Response(body, { status: step.status, headers });
}

function abortError() {
  return new DOMException("This operation was aborted", "AbortError");
}

function telemetryFetch() {
  const posts = [];
  const script = [];
  const held = new Map();
  let defaultStep = { status: 200 };

  const fn = jest.fn((url, options = {}) => {
    if (typeof url !== "string" || !url.includes("/api/v1/telemetry/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ evaluations: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    const i = posts.length;
    posts.push({ url, options, body: options.body });
    const step = script.length > 0 ? script.shift() : defaultStep;
    const signal = options.signal;

    if (signal && signal.aborted) return Promise.reject(abortError());
    if (step.networkError) return Promise.reject(new TypeError("Failed to fetch"));
    if (!step.hang) return Promise.resolve(makeResponse(step));

    return new Promise((resolve, reject) => {
      held.set(i, (next) => resolve(makeResponse(next)));
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            held.delete(i);
            reject(abortError());
          },
          { once: true }
        );
      }
    });
  });

  return {
    fetch: fn,
    /** Queue steps for the next telemetry POSTs, in order. */
    script: (...steps) => script.push(...steps),
    /** Step used once the script runs out (default 200). */
    setDefault: (step) => {
      defaultStep = step;
    },
    postCount: () => posts.length,
    post: (i) => posts[i],
    body: (i) => posts[i].body,
    sha: (i) => crypto.createHash("sha256").update(posts[i].body).digest("hex"),
    keys: (i) =>
      JSON.parse(posts[i].body)
        .events.flatMap((e) => e.summaries.summaries)
        .map((s) => s.key)
        .sort(),
    /** Answer a held (hanging) POST. */
    release: (i, step = { status: 200 }) => {
      const r = held.get(i);
      if (!r) throw new Error(`POST ${i} is not held`);
      held.delete(i);
      r(step);
    },
  };
}

module.exports = { telemetryFetch };
