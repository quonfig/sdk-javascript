import { v4 as uuid } from "uuid";

import { Config } from "./config";
import { contextsEqual, validateContexts } from "./context";
import { EvaluationSummaryAggregator } from "./telemetry/evaluationSummaryAggregator";
import Loader from "./loader";
import {
  PREFIX as loggerPrefix,
  isValidLogLevel,
  shouldLog,
  type Severity,
} from "./logger";
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
  ShouldLogArgs,
} from "./types";

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

  public clientNameString = "quonfig-javascript";
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
    telemetryUrl,
    timeout,
    afterEvaluationCallback = () => {},
    collectEvaluationSummaries = true,
    collectLoggerNames = false,
    contextUploadMode = "periodic_example",
  }: InitOptions): Promise<void> {
    if (!context) {
      throw new Error("Context must be provided");
    }

    validateContexts(context);
    this._contexts = context;

    const clientVersionString = `${this.clientNameString}-${version}`;

    this.loader = new Loader({
      sdkKey,
      contexts: context,
      apiUrls,
      timeout,
      contextUploadMode,
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
   * Tear down the SDK: stop polling and telemetry.
   */
  close(): void {
    this.stopPolling();
    this.stopTelemetry();
  }

  /**
   * Stop telemetry aggregators.
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
      if (!key.startsWith(loggerPrefix)) {
        console.warn(
          `Quonfig warning: The client has not finished loading data yet. Unable to look up actual value for key "${key}".`
        );
      }
      return undefined;
    }

    const config = this.configs[key];
    const value = config?.value;

    if (!key.startsWith(loggerPrefix)) {
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
   */
  shouldLog(args: ShouldLogArgs, async = true): boolean {
    if (this._collectLoggerNames && isValidLogLevel(args.desiredLevel)) {
      const record = () =>
        this.loggerAggregator?.record(
          args.loggerName,
          args.desiredLevel.toUpperCase() as Severity
        );
      if (async) {
        setTimeout(record);
      } else {
        record();
      }
    }

    return shouldLog({ ...args, get: this.get.bind(this) });
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
