const { Quonfig, QUONFIG_SDK_LOGGING_CONTEXT_NAME } = require("../dist");

// Helper: build a Quonfig instance, seed it with pre-evaluated log-level configs
// via `hydrate`, and set `_loggerKey` + `_collectLoggerNames` directly — we skip
// `init()` here so the test does not need a live server. This mirrors what the
// bootstrap path does in production.
function buildClient({ hydratedFlags, loggerKey, collectLoggerNames = false }) {
  const q = new Quonfig();
  // Directly populate the internal state that `init` would otherwise set up.
  q._loggerKey = loggerKey;
  q._collectLoggerNames = collectLoggerNames;
  q._contexts = {};
  q.hydrate(hydratedFlags);
  return q;
}

describe("shouldLog({loggerPath}) convenience", () => {
  test("uses loggerKey as the config key and passes loggerPath through unnormalized to contexts", () => {
    const q = buildClient({
      loggerKey: "log-level.my-app",
      hydratedFlags: { "log-level.my-app": "DEBUG" },
    });

    // debug is configured -> debug emits debug/info/warn/error/fatal.
    expect(q.shouldLog({ loggerPath: "MyApp::Services::Auth", desiredLevel: "debug" })).toBe(true);
    expect(q.shouldLog({ loggerPath: "MyApp::Services::Auth", desiredLevel: "info" })).toBe(true);
    // trace is MORE verbose than debug -> should NOT emit.
    expect(q.shouldLog({ loggerPath: "MyApp::Services::Auth", desiredLevel: "trace" })).toBe(false);

    // The loggerPath is published as-is (no snake_case, no dot-ification) under
    // the load-bearing "quonfig-sdk-logging" context name with nested `key`.
    expect(q.contexts[QUONFIG_SDK_LOGGING_CONTEXT_NAME]).toEqual({
      key: "MyApp::Services::Auth",
    });

    // A second call with a different logger path updates the injected context
    // so telemetry auto-capture tracks per-logger usage.
    q.shouldLog({ loggerPath: "other.dotted.name", desiredLevel: "info" });
    expect(q.contexts[QUONFIG_SDK_LOGGING_CONTEXT_NAME]).toEqual({
      key: "other.dotted.name",
    });
  });

  test("respects the configured log level for the loggerKey", () => {
    const q = buildClient({
      loggerKey: "log-level.quiet-app",
      hydratedFlags: { "log-level.quiet-app": "ERROR" },
    });

    // error is configured -> info is MORE verbose, should not emit.
    expect(q.shouldLog({ loggerPath: "svc.billing", desiredLevel: "info" })).toBe(false);
    // error -> error itself emits.
    expect(q.shouldLog({ loggerPath: "svc.billing", desiredLevel: "error" })).toBe(true);
  });

  test("falls back to defaultLevel when the loggerKey has no value", () => {
    // loggerKey key is NOT hydrated — there is no config value to resolve.
    const q = buildClient({
      loggerKey: "log-level.missing",
      hydratedFlags: {},
    });

    // defaultLevel=warn -> warn emits warn, does NOT emit info.
    expect(
      q.shouldLog({
        loggerPath: "my.logger",
        desiredLevel: "warn",
        defaultLevel: "warn",
      })
    ).toBe(true);
    expect(
      q.shouldLog({
        loggerPath: "my.logger",
        desiredLevel: "info",
        defaultLevel: "warn",
      })
    ).toBe(false);
  });

  test("defaultLevel is optional for the loggerPath form (defaults to WARN)", () => {
    const q = buildClient({
      loggerKey: "log-level.missing",
      hydratedFlags: {},
    });

    // Implicit defaultLevel=WARN -> warn emits, info does not.
    expect(q.shouldLog({ loggerPath: "my.logger", desiredLevel: "warn" })).toBe(true);
    expect(q.shouldLog({ loggerPath: "my.logger", desiredLevel: "info" })).toBe(false);
  });

  test("throws when loggerPath is passed but loggerKey was not set at init", () => {
    const q = buildClient({
      loggerKey: undefined,
      hydratedFlags: { "log-level.something": "INFO" },
    });

    expect(() => q.shouldLog({ loggerPath: "foo.bar", desiredLevel: "info" })).toThrow(/loggerKey/);
  });

  test("throws when both configKey and loggerPath are passed", () => {
    const q = buildClient({
      loggerKey: "log-level.my-app",
      hydratedFlags: { "log-level.my-app": "INFO" },
    });

    expect(() =>
      q.shouldLog({
        configKey: "log-level.my-app",
        loggerPath: "foo.bar",
        desiredLevel: "info",
      })
    ).toThrow(/either `configKey` or `loggerPath`/);
  });

  test("preserves the existing shouldLog({configKey}) primitive unchanged", () => {
    const q = buildClient({
      loggerKey: undefined, // deliberately not set — configKey is the escape hatch
      hydratedFlags: { "log-level.raw": "INFO" },
    });

    // info emits info but not debug.
    expect(
      q.shouldLog({
        configKey: "log-level.raw",
        desiredLevel: "info",
        defaultLevel: "warn",
      })
    ).toBe(true);
    expect(
      q.shouldLog({
        configKey: "log-level.raw",
        desiredLevel: "debug",
        defaultLevel: "warn",
      })
    ).toBe(false);

    // configKey form must NOT inject the quonfig-sdk-logging context.
    expect(q.contexts[QUONFIG_SDK_LOGGING_CONTEXT_NAME]).toBeUndefined();
  });

  test("configKey form still walks up dotted keys (backward-compat)", () => {
    // The existing primitive looks up parent keys on `.` boundaries until it
    // finds a match, or falls back to defaultLevel. This behavior is preserved.
    const q = buildClient({
      loggerKey: undefined,
      hydratedFlags: { "log-level.app": "ERROR" },
    });

    // log-level.app.submodule -> walk up to log-level.app -> error -> does not emit info.
    expect(
      q.shouldLog({
        configKey: "log-level.app.submodule",
        desiredLevel: "info",
        defaultLevel: "debug",
      })
    ).toBe(false);
    expect(
      q.shouldLog({
        configKey: "log-level.app.submodule",
        desiredLevel: "error",
        defaultLevel: "debug",
      })
    ).toBe(true);
  });
});
