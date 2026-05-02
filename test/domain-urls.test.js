/**
 * QUONFIG_DOMAIN env var derivation for default api/telemetry URLs.
 *
 * Resolution order (highest wins):
 *   1. Explicit option (apiUrls / telemetryUrl on InitOptions)
 *   2. process.env.QUONFIG_DOMAIN (Node / build-time only)
 *   3. Hardcoded default "quonfig.com"
 *
 * The env-var read MUST be guarded so a missing `process` global does not
 * throw in pure browser contexts.
 */

const path = require("path");

// Helpers to load the compiled modules with a fresh module cache so that
// `process.env.QUONFIG_DOMAIN` is read each time the constants are
// initialized. The defaults are computed lazily inside getDefault*() so a
// straight require() reload still picks up env changes.
function loadModules() {
  const apiHelpersPath = require.resolve(
    path.join(__dirname, "..", "dist", "apiHelpers")
  );
  const uploaderPath = require.resolve(
    path.join(__dirname, "..", "dist", "telemetry", "uploader")
  );
  const loaderPath = require.resolve(
    path.join(__dirname, "..", "dist", "loader")
  );
  delete require.cache[apiHelpersPath];
  delete require.cache[uploaderPath];
  delete require.cache[loaderPath];
  const apiHelpers = require(apiHelpersPath);
  const TelemetryUploader = require(uploaderPath).default;
  const Loader = require(loaderPath).default;
  return { apiHelpers, TelemetryUploader, Loader };
}

describe("QUONFIG_DOMAIN env var → default URLs", () => {
  const ORIGINAL_DOMAIN = process.env.QUONFIG_DOMAIN;
  const ORIGINAL_TELEMETRY = process.env.QUONFIG_TELEMETRY_URL;

  afterEach(() => {
    if (ORIGINAL_DOMAIN === undefined) {
      delete process.env.QUONFIG_DOMAIN;
    } else {
      process.env.QUONFIG_DOMAIN = ORIGINAL_DOMAIN;
    }
    if (ORIGINAL_TELEMETRY === undefined) {
      delete process.env.QUONFIG_TELEMETRY_URL;
    } else {
      process.env.QUONFIG_TELEMETRY_URL = ORIGINAL_TELEMETRY;
    }
  });

  test("with no env var set: api defaults are prod primary+secondary", () => {
    delete process.env.QUONFIG_DOMAIN;
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultApiUrls()).toEqual([
      "https://primary.quonfig.com",
      "https://secondary.quonfig.com",
    ]);
  });

  test("with no env var set: telemetry default is prod telemetry url", () => {
    delete process.env.QUONFIG_DOMAIN;
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultTelemetryUrl()).toBe(
      "https://telemetry.quonfig.com"
    );
  });

  test("with QUONFIG_DOMAIN=quonfig-staging.com: api defaults follow", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultApiUrls()).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
  });

  test("with QUONFIG_DOMAIN=quonfig-staging.com: telemetry default follows", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultTelemetryUrl()).toBe(
      "https://telemetry.quonfig-staging.com"
    );
  });

  test("Loader picks up QUONFIG_DOMAIN-derived defaults when apiUrls option omitted", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { Loader } = loadModules();
    const loader = new Loader({
      sdkKey: "test-key",
      contexts: { user: { key: "alice" } },
    });
    expect(loader.apiUrls).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
  });

  test("TelemetryUploader picks up QUONFIG_DOMAIN-derived default when telemetryUrl option omitted", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { TelemetryUploader } = loadModules();
    const u = new TelemetryUploader({
      sdkKey: "test-key",
      clientVersion: "test",
    });
    expect(u.telemetryUrl).toBe("https://telemetry.quonfig-staging.com");
  });

  test("explicit apiUrls option overrides QUONFIG_DOMAIN", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { Loader } = loadModules();
    const loader = new Loader({
      sdkKey: "test-key",
      contexts: { user: { key: "alice" } },
      apiUrls: ["https://api.example.com"],
    });
    expect(loader.apiUrls).toEqual(["https://api.example.com"]);
  });

  test("explicit telemetryUrl option overrides QUONFIG_DOMAIN", () => {
    process.env.QUONFIG_DOMAIN = "quonfig-staging.com";
    const { TelemetryUploader } = loadModules();
    const u = new TelemetryUploader({
      sdkKey: "test-key",
      telemetryUrl: "https://telemetry.example.com",
      clientVersion: "test",
    });
    expect(u.telemetryUrl).toBe("https://telemetry.example.com");
  });

  test("QUONFIG_TELEMETRY_URL env var is NOT honored (alpha: removed, no back-compat)", () => {
    delete process.env.QUONFIG_DOMAIN;
    process.env.QUONFIG_TELEMETRY_URL = "https://should-be-ignored.example.com";
    const { TelemetryUploader } = loadModules();
    const u = new TelemetryUploader({
      sdkKey: "test-key",
      clientVersion: "test",
    });
    expect(u.telemetryUrl).toBe("https://telemetry.quonfig.com");
  });

  test("getDefaultApiUrls({ domain }) wins over QUONFIG_DOMAIN env var", () => {
    process.env.QUONFIG_DOMAIN = "env-should-lose.example";
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultApiUrls({ domain: "quonfig-staging.com" })).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
  });

  test("getDefaultTelemetryUrl({ domain }) wins over QUONFIG_DOMAIN env var", () => {
    process.env.QUONFIG_DOMAIN = "env-should-lose.example";
    const { apiHelpers } = loadModules();
    expect(apiHelpers.getDefaultTelemetryUrl({ domain: "quonfig-staging.com" })).toBe(
      "https://telemetry.quonfig-staging.com",
    );
  });

  test("Loader picks up domain option when apiUrls omitted", () => {
    delete process.env.QUONFIG_DOMAIN;
    const { Loader } = loadModules();
    const loader = new Loader({
      sdkKey: "test-key",
      contexts: { user: { key: "alice" } },
      domain: "quonfig-staging.com",
    });
    expect(loader.apiUrls).toEqual([
      "https://primary.quonfig-staging.com",
      "https://secondary.quonfig-staging.com",
    ]);
  });

  test("TelemetryUploader picks up domain option when telemetryUrl omitted", () => {
    delete process.env.QUONFIG_DOMAIN;
    const { TelemetryUploader } = loadModules();
    const u = new TelemetryUploader({
      sdkKey: "test-key",
      domain: "quonfig-staging.com",
      clientVersion: "test",
    });
    expect(u.telemetryUrl).toBe("https://telemetry.quonfig-staging.com");
  });

  test("env-var read is guarded: missing process global does not throw", () => {
    // Simulate a pure-browser environment where `process` does not exist.
    // We can't actually delete the Node `process` global without breaking
    // Jest, so we stash and restore it just for the duration of this test.
    const savedProcess = global.process;
    // `delete global.process` is a no-op in Node strict mode in some
    // versions; assign undefined instead, which is what bundlers leave when
    // they fail to inline `process.env`.
    // eslint-disable-next-line no-global-assign
    global.process = undefined;
    try {
      // The compiled module reads process.env at module-load time AND at
      // call time of getDefault*(). Either path must guard.
      expect(() => {
        const apiHelpersPath = require.resolve(
          path.join(__dirname, "..", "dist", "apiHelpers")
        );
        delete require.cache[apiHelpersPath];
        const apiHelpers = require(apiHelpersPath);
        apiHelpers.getDefaultApiUrls();
        apiHelpers.getDefaultTelemetryUrl();
      }).not.toThrow();
    } finally {
      // eslint-disable-next-line no-global-assign
      global.process = savedProcess;
    }
  });
});
