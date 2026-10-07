/**
 * qfg-goi1.2.7: a superseded load is inert.
 *
 * `loadHedged` supersedes the previous call (an updateContext racing a refresh
 * or a poll tick) by aborting its fetch legs. The abort alone did not make the
 * old call harmless:
 *   - r2: a leg whose body still completed (the abort raced it, or the runtime's
 *     fetch does not abort a body read) drained through onResult under the OLD
 *     context's signature. applyLoaderResult saw a "context switch" and
 *     installed the previous user's values while `contexts` said the new user.
 *   - r10: the aborted primary counted as a primary FAILURE, so the old call
 *     fired its secondary leg (fetching the NEW context but reporting under the
 *     OLD signature), and its hedge timer was never cleared.
 *   - With every leg failed, the old call served last-known-good for whatever
 *     context the loader held by then, again under the old signature.
 *
 * A superseded call now does nothing: no onResult, no secondaries, no LKG, its
 * hedge timer is cleared, and its promise settles with the call that replaced
 * it.
 */

const Loader = require("../dist/loader").default;
const { Quonfig } = require("../dist/quonfig");
const { encodeContexts } = require("../dist/context");
const { writeLkg } = require("../dist/lkgCache");

const SDK_KEY = "qf_pk_development_test";
const PRIMARY = "https://primary.quonfig-staging.com";
const SECONDARY = "https://secondary.quonfig-staging.com";
const A = { user: { key: "A" } };
const B = { user: { key: "B" } };
const C = { user: { key: "C" } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payloadFor = (ctx, generation = 5) => ({
  evaluations: { plan: { value: { type: "string", value: `plan-for-${ctx.user.key}` } } },
  meta: { version: `gen-${generation}`, environment: "Production", generation },
});

const ctxOf = (url) => [A, B, C].find((ctx) => url.includes(encodeContexts(ctx)));
const hostOf = (url) => (url.includes("//primary.") ? "primary" : "secondary");

// A response for `url`'s context after `delayMs`, rejected with an AbortError if
// the request's signal fires first (what a real fetch does).
const abortableResponse = (url, signal, delayMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify(payloadFor(ctxOf(url))), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        ),
      delayMs
    );
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("This operation was aborted", "AbortError"));
    });
  });

// Headers now, body after `delayMs`, and the body read does not observe the
// abort: the leg completes even though it was superseded.
const unabortableSlowBody = (url, delayMs) => {
  const response = new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  response.json = () => sleep(delayMs).then(() => payloadFor(ctxOf(url)));
  return Promise.resolve(response);
};

// Records every request as "<host>:<context key>".
function recordingFetch(respond) {
  const legs = [];
  const fn = jest.fn((url, { signal }) => {
    legs.push(`${hostOf(url)}:${ctxOf(url).user.key}`);
    return respond(url, signal);
  });
  fn.legs = legs;
  return fn;
}

function fakeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

describe("a superseded loadHedged call is inert", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const loaderFor = (overrides) =>
    new Loader({
      sdkKey: SDK_KEY,
      contexts: A,
      apiUrls: [PRIMARY, SECONDARY],
      hedgeDelay: 200,
      timeout: 1000,
      ...overrides,
    });

  test("its onResult is never called, even when its leg's body still completes", async () => {
    global.fetch = recordingFetch((url, signal) =>
      ctxOf(url) === A ? unabortableSlowBody(url, 150) : abortableResponse(url, signal, 10)
    );
    const loader = loaderFor({ apiUrls: [PRIMARY] });

    const first = [];
    loader.loadHedged((r) => first.push(r));
    await sleep(20);
    loader.contexts = B;
    const second = [];
    await loader.loadHedged((r) => second.push(r));
    await sleep(200);

    expect(second.map((r) => r.payload.evaluations.plan.value.value)).toEqual(["plan-for-B"]);
    expect(first).toEqual([]);
  });

  test("its aborted primary does not fire the secondary leg", async () => {
    global.fetch = recordingFetch((url, signal) => abortableResponse(url, signal, 30));
    const loader = loaderFor();

    loader.loadHedged(() => {});
    loader.contexts = B;
    await loader.loadHedged(() => {});
    await sleep(50);

    expect(global.fetch.legs).toEqual(["primary:A", "primary:B"]);
  });

  test("its hedge timer is cleared", async () => {
    // A's primary never answers and ignores the abort, so only the old call's
    // hedge timer could start a secondary leg.
    global.fetch = recordingFetch((url, signal) =>
      ctxOf(url) === A ? new Promise(() => {}) : abortableResponse(url, signal, 5)
    );
    const loader = loaderFor({ hedgeDelay: 40 });

    loader.loadHedged(() => {});
    await sleep(10);
    loader.contexts = B;
    await loader.loadHedged(() => {});
    await sleep(80);

    expect(global.fetch.legs).toEqual(["primary:A", "primary:B"]);
  });

  describe("with last-known-good cached", () => {
    let originalLS;
    beforeEach(() => {
      originalLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", {
        value: fakeLocalStorage(),
        configurable: true,
        writable: true,
      });
    });
    afterEach(() => {
      if (originalLS) Object.defineProperty(globalThis, "localStorage", originalLS);
      else delete globalThis.localStorage;
    });

    test("it does not serve last-known-good", async () => {
      writeLkg(SDK_KEY, encodeContexts(B), { generation: 3, payload: payloadFor(B, 3) });
      global.fetch = recordingFetch((url, signal) => abortableResponse(url, signal, 30));
      const loader = loaderFor({ apiUrls: [PRIMARY] });

      const first = [];
      loader.loadHedged((r) => first.push(r));
      loader.contexts = B;
      const second = [];
      await loader.loadHedged((r) => second.push(r));
      await sleep(20);

      expect(first).toEqual([]);
      expect(second.map((r) => r.stale === true)).toEqual([false]);
    });
  });

  test("its promise settles with the call that replaced it, instead of rejecting with the abort", async () => {
    global.fetch = recordingFetch((url, signal) => abortableResponse(url, signal, 30));
    const loader = loaderFor({ apiUrls: [PRIMARY] });

    let secondDone = false;
    const first = loader
      .loadHedged(() => {})
      .then(
        () => (secondDone ? "resolved after the replacement" : "resolved before the replacement"),
        (error) => `rejected: ${error.message}`
      );
    loader.contexts = B;
    loader
      .loadHedged(() => {})
      .then(() => {
        secondDone = true;
      });

    expect(await first).toBe("resolved after the replacement");
  });
});

describe("updateContext racing an in-flight load (Quonfig)", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const init = (q, apiUrls) =>
    q.init({
      sdkKey: SDK_KEY,
      context: A,
      apiUrls,
      hedgeDelay: 200,
      timeout: 1000,
      collectEvaluationSummaries: false,
    });

  test("r2: a refresh for A whose body lands after updateContext(B) does not install A's values", async () => {
    let slowA = false;
    global.fetch = recordingFetch((url, signal) =>
      slowA && ctxOf(url) === A ? unabortableSlowBody(url, 150) : abortableResponse(url, signal, 5)
    );
    const q = new Quonfig();
    await init(q, [PRIMARY]);
    expect(q.get("plan")).toBe("plan-for-A");

    slowA = true;
    const refresh = q.updateContext(A);
    await sleep(20);
    await q.updateContext(B);
    expect(q.get("plan")).toBe("plan-for-B");

    await refresh;
    await sleep(200);
    expect(q.contexts).toEqual(B);
    expect(q.get("plan")).toBe("plan-for-B");
  });

  test("r10: back-to-back updateContext calls against a healthy primary fire no secondary leg", async () => {
    global.fetch = recordingFetch((url, signal) => abortableResponse(url, signal, 30));
    const q = new Quonfig();
    await init(q, [PRIMARY, SECONDARY]);

    const toB = q.updateContext(B);
    await q.updateContext(C);
    await toB;
    await sleep(50);

    expect(global.fetch.legs).toEqual(["primary:A", "primary:B", "primary:C"]);
    expect(q.get("plan")).toBe("plan-for-C");
  });
});
