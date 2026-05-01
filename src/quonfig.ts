import { v4 as uuid } from "uuid";

import { Config } from "./config";
import { contextsEqual, validateContexts } from "./context";
import { EvaluationSummaryAggregator } from "./telemetry/evaluationSummaryAggregator";
import Loader from "./loader";
import { isValidLogLevel, shouldLog, type Severity } from "./logger";

const LOG_LEVEL_KEY_PREFIX = "log-level";
import TelemetryUploader from "./telemetry/uploader";
import { LoggerAggregator } from "./telemetry/loggerAggregator";
import version from "./version";
import type {
  ConfigValue,
  Contexts,
  Duration,
  EvaluationCallback,
  EvaluationPayload,
  InitOptions,
} from "./types";
import { QUONFIG_SDK_LOGGING_CONTEXT_NAME } from "./types";

type PollStatus =
  | { status: "not-started" }
  | { status: "pending" }
  | { status: "stopped" }
  | { status: "running"; frequencyInMs: number };

export interface QuonfigBootstrap {
  evaluations: EvaluationPayload["evaluations"];
  context: Contexts;
}

export class Quonfig {
  private _configs: { [key: string]: Config } = {};
  private _telemetryUploader: TelemetryUploader | undefined;
  private _pollCount = 0;
  private _pollStatus: PollStatus = { status: "not-started" };
  private _pollTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private _instanceHash: string = uuid();
  private _collectEvaluationSummaries = true;
  private _collectLoggerNames = false;
  private evaluationSummaryAggregator: EvaluationSummaryAggregator | undefined;
  private loggerAggregator: LoggerAggregator | undefined;
  private _contexts: Contexts = {};
  private _loggerKey: string | undefined;

  // SDK identity reported in telemetry. Wrappers (e.g. @quonfig/react)
  // overwrite these on init so each wrapper SDK shows up distinctly in the
  // telemetry tables, with its own semver. Defaults are the values reported
  // when this SDK is used directly from a browser.
  public clientName = "javascript";
  public clientVersion: string = version;
  public loaded = false;
  public loader: Loader | undefined;
  public afterEvaluationCallback: EvaluationCallback = () => {};

  /**
   * Initialize the SDK. Must be called before any other methods.
   */
  async init({
    sdkKey,
    context,
    apiUrls,
    apiUrl,
    telemetryUrl,
    timeout,
    afterEvaluationCallback = () => {},
    collectEvaluationSummaries = true,
    collectLoggerNames = false,
    collectContextMode = "PERIODIC_EXAMPLE",
    loggerKey,
  }: InitOptions): Promise<void> {
    if (!context) {
      throw new Error("Context must be provided");
    }

    validateContexts(context);
    this._contexts = context;
    this._loggerKey = loggerKey;

    // Accept singular `apiUrl` as an alias for `apiUrls`. `apiUrls` wins if both
    // are provided. Mirrors the normalization @quonfig/react already does on
    // its provider props (qfg-f4g) so a staging caller passing the singular
    // form doesn't silently fall back to the prod default URLs.
    const resolvedApiUrls = apiUrls ?? (apiUrl ? [apiUrl] : undefined);

    const clientVersionString = `${this.clientName}-${this.clientVersion}`;

    this.loader = new Loader({
      sdkKey,
      contexts: context,
      apiUrls: resolvedApiUrls,
      timeout,
      collectContextMode,
      clientVersion: clientVersionString,
    });

    this._telemetryUploader = new TelemetryUploader({
      sdkKey,
      telemetryUrl,
      timeout,
      clientVersion: clientVersionString,
    });

    this._collectEvaluationSummaries = collectEvaluationSummaries;
    if (collectEvaluationSummaries) {
      this.evaluationSummaryAggregator = new EvaluationSummaryAggregator(this, 100000);
    }

    this._collectLoggerNames = collectLoggerNames;
    if (collectLoggerNames) {
      this.loggerAggregator = new LoggerAggregator(this, 100000);
    }

    // Flush telemetry on page unload (browser only)
    if (
      (collectEvaluationSummaries || collectLoggerNames) &&
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      window.addEventListener("beforeunload", () => {
        this.evaluationSummaryAggregator?.sync();
        this.loggerAggregator?.sync();
      });
    }

    this.afterEvaluationCallback = afterEvaluationCallback;

    return this.load();
  }

  // -- Accessors --

  get configs(): { [key: string]: Config } {
    return this._configs;
  }

  get contexts(): Contexts {
    return this._contexts;
  }

  get instanceHash(): string {
    return this._instanceHash;
  }

  get pollTimeoutId() {
    return this._pollTimeoutId;
  }

  get pollCount() {
    return this._pollCount;
  }

  get pollStatus() {
    return this._pollStatus;
  }

  get telemetryUploader(): TelemetryUploader | undefined {
    return this._telemetryUploader;
  }

  /** The init-time `loggerKey` used by the `shouldLog({loggerPath, ...})` overload. */
  get loggerKey(): string | undefined {
    return this._loggerKey;
  }

  // -- Core Methods --

  /**
   * Internal: load configs from server.
   */
  private async load(): Promise<void> {
    if (!this.loader) {
      throw new Error("Quonfig not initialized. Call init() first.");
    }

    // Check for bootstrap data
    if (globalThis && (globalThis as any)._quonfigBootstrap) {
      const bootstrap = (globalThis as any)._quonfigBootstrap as QuonfigBootstrap;

      if (contextsEqual(this._contexts, bootstrap.context)) {
        this.setConfig({ evaluations: bootstrap.evaluations });
        return;
      }
    }

    // Ensure loader has the freshest context
    this.loader.contexts = this._contexts;

    return this.loader
      .load()
      .then((payload: EvaluationPayload) => {
        this.setConfig(payload);
      })
      .finally(() => {
        if (this.pollStatus.status === "running") {
          this._pollCount += 1;
        }
      });
  }

  /**
   * Update the context and re-fetch evaluated configs from the server.
   */
  async updateContext(context: Contexts, skipLoad = false): Promise<void> {
    if (!this.loader) {
      throw new Error("Quonfig not initialized. Call init() first.");
    }

    validateContexts(context);
    this._contexts = context;

    if (skipLoad) {
      return;
    }

    return this.load();
  }

  /**
   * Start polling the server for config updates at the given frequency.
   */
  async poll({ frequencyInMs }: { frequencyInMs: number }): Promise<void> {
    if (!this.loader) {
      throw new Error("Quonfig not initialized. Call init() first.");
    }

    this.stopPolling();
    this._pollStatus = { status: "pending" };

    return this.loader.load().then((payload) => {
      this.setConfig(payload);
      this.doPolling({ frequencyInMs });
    });
  }

  private doPolling({ frequencyInMs }: { frequencyInMs: number }) {
    this._pollTimeoutId = setTimeout(() => {
      this.load().finally(() => {
        if (this.pollStatus.status === "running") {
          this.doPolling({ frequencyInMs });
        }
      });
    }, frequencyInMs);

    this._pollStatus = { status: "running", frequencyInMs };
  }

  /**
   * Stop polling for config updates.
   */
  stopPolling(): void {
    if (this.pollTimeoutId) {
      clearTimeout(this.pollTimeoutId);
      this._pollTimeoutId = undefined;
    }
    this._pollStatus = { status: "stopped" };
  }

  /**
   * Drain in-memory telemetry counters by POSTing them to the telemetry
   * endpoint. Use this when you want to ensure counters are shipped without
   * tearing down the SDK (e.g. before a context swap in a long-lived SPA).
   */
  async flush(): Promise<void> {
    await Promise.all([
      this.evaluationSummaryAggregator?.sync(),
      this.loggerAggregator?.sync(),
    ]);
  }

  /**
   * Tear down the SDK: drain telemetry, then stop polling and telemetry timers.
   */
  async close(): Promise<void> {
    await this.flush();
    this.stopPolling();
    this.stopTelemetry();
  }

  /**
   * Stop telemetry aggregator timers without draining. Prefer `close()` or
   * `flush()` for normal teardown — those drain pending counters first.
   */
  stopTelemetry(): void {
    this.evaluationSummaryAggregator?.stop();
    this.loggerAggregator?.stop();
  }

  /**
   * Set configs from a raw evaluation payload.
   */
  setConfig(rawValues: EvaluationPayload) {
    this._configs = Config.digest(rawValues);
    this.loaded = true;
  }

  /**
   * Seed the client with pre-evaluated flags (e.g. for SSR hydration).
   * Flags are flat key-value pairs: { flagKey: value }.
   */
  hydrate(flags: Record<string, unknown>): void {
    const configs: { [key: string]: Config } = { ...this._configs };
    Object.keys(flags).forEach((key) => {
      const value = flags[key] as ConfigValue;
      const type =
        typeof value === "boolean"
          ? "bool"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "int"
              : "double"
            : "string";
      configs[key] = new Config(key, value, type);
    });
    this._configs = configs;
    this.loaded = true;
  }

  /**
   * Extract the current evaluated config as a flat key-value map.
   */
  extract(): Record<string, ConfigValue> {
    const result: Record<string, ConfigValue> = {};
    Object.keys(this._configs).forEach((key) => {
      result[key] = this._configs[key].value;
    });
    return result;
  }

  // -- Query Methods --

  /**
   * Check if a feature flag is enabled. Returns false for any non-true value.
   */
  isEnabled(key: string): boolean {
    return this.get(key) === true;
  }

  /**
   * Get the evaluated value for a config key.
   */
  get(key: string): ConfigValue {
    if (!this.loaded) {
      if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
        console.warn(
          `Quonfig warning: The client has not finished loading data yet. Unable to look up actual value for key "${key}".`
        );
      }
      return undefined;
    }

    const config = this.configs[key];
    const value = config?.value;

    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      if (this._collectEvaluationSummaries) {
        setTimeout(() => this.evaluationSummaryAggregator?.record(config));
      }
      setTimeout(() => this.afterEvaluationCallback(key, value, this._contexts));
    }

    return value;
  }

  /**
   * Get the evaluated value for a key, asserting it is a Duration.
   */
  getDuration(key: string): Duration | undefined {
    const value = this.get(key);

    if (!value) {
      return undefined;
    }

    if (
      !Object.prototype.hasOwnProperty.call(value, "seconds") ||
      !Object.prototype.hasOwnProperty.call(value, "ms")
    ) {
      throw new Error(`Value for key "${key}" is not a duration`);
    }

    return value as Duration;
  }

  /**
   * Determine whether a log message at the given level should be emitted.
   *
   * Two shapes are supported:
   *
   * 1. `{configKey, ...}` — primitive shape. Evaluates the named config as a
   *    log level. The caller is responsible for any per-logger routing.
   *
   * 2. `{loggerPath, ...}` — convenience shape. Requires `loggerKey` on
   *    `init()`. The SDK uses `loggerKey` as the underlying config key and
   *    injects `contexts["quonfig-sdk-logging"] = { key: loggerPath }` into
   *    the live client contexts so the logger path is auto-captured by the
   *    existing example-context telemetry. `loggerPath` is passed through
   *    without normalization.
   */
  shouldLog(args: {
    configKey: string;
    desiredLevel: string;
    defaultLevel: string;
  }, async?: boolean): boolean;
  shouldLog(args: {
    loggerPath: string;
    desiredLevel: string;
    defaultLevel?: string;
  }, async?: boolean): boolean;
  shouldLog(
    args: {
      configKey?: string;
      loggerPath?: string;
      desiredLevel: string;
      defaultLevel?: string;
    },
    async: boolean = true
  ): boolean {
    let resolvedConfigKey: string;
    // Default fallback matches sdk-node (WARN).
    let resolvedDefaultLevel = args.defaultLevel ?? "WARN";
    // The name recorded in logger-name telemetry: for the loggerPath form we
    // prefer the logger path itself (the thing the user cares about), for the
    // configKey form we keep the old behavior of recording the config key.
    let telemetryName: string;

    if (args.loggerPath !== undefined) {
      if (args.configKey !== undefined) {
        throw new Error(
          "[quonfig] shouldLog: pass either `configKey` or `loggerPath`, not both."
        );
      }
      if (!this._loggerKey) {
        throw new Error(
          "[quonfig] shouldLog({loggerPath}) requires the `loggerKey` option on quonfig.init(). " +
            'Pass `loggerKey: "log-level.<your-app>"` or use the `configKey` form instead.'
        );
      }
      resolvedConfigKey = this._loggerKey;
      telemetryName = args.loggerPath;

      // Publish the logger path under the `quonfig-sdk-logging` context name
      // using a `key` property. This matches the sdk-node/sdk-go/sdk-ruby
      // shape exactly and is load-bearing for example-context telemetry
      // auto-capture: the dashboard harvests contexts that carry a `key`, so
      // logger paths flow through for free.
      //
      // Note: in the browser SDK, config evaluation happens server-side, so
      // this does not influence the current request's rule evaluation. It
      // does, however, make the injected context visible to telemetry and
      // to any future `updateContext` / loader re-fetch.
      this._contexts = {
        ...this._contexts,
        [QUONFIG_SDK_LOGGING_CONTEXT_NAME]: { key: args.loggerPath },
      };
      if (this.loader) {
        this.loader.contexts = this._contexts;
      }
    } else if (args.configKey !== undefined) {
      resolvedConfigKey = args.configKey;
      telemetryName = args.configKey;
    } else {
      throw new Error(
        "[quonfig] shouldLog requires either `configKey` or `loggerPath`."
      );
    }

    if (this._collectLoggerNames && isValidLogLevel(args.desiredLevel)) {
      const record = () =>
        this.loggerAggregator?.record(
          telemetryName,
          args.desiredLevel.toUpperCase() as Severity
        );
      if (async) {
        setTimeout(record);
      } else {
        record();
      }
    }

    return shouldLog({
      configKey: resolvedConfigKey,
      desiredLevel: args.desiredLevel,
      defaultLevel: resolvedDefaultLevel,
      get: this.get.bind(this),
    });
  }

  /**
   * Whether evaluation summary telemetry is being collected.
   */
  isCollectingEvaluationSummaries(): boolean {
    return this._collectEvaluationSummaries;
  }

  /**
   * Whether logger name telemetry is being collected.
   */
  isCollectingLoggerNames(): boolean {
    return this._collectLoggerNames;
  }
}

/** Singleton instance for convenience. */
export const quonfig = new Quonfig();
