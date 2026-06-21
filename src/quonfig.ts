import { v4 as uuid } from "uuid";

import { Config } from "./config";
import { contextsEqual, encodeContexts, validateContexts } from "./context";
import { EvaluationSummaryAggregator } from "./telemetry/evaluationSummaryAggregator";
import Loader, { type LoaderResult } from "./loader";
import { shouldLog } from "./logger";

const LOG_LEVEL_KEY_PREFIX = "log-level";
import TelemetryUploader from "./telemetry/uploader";
import version from "./version";
import type {
  ConfigValue,
  Contexts,
  Duration,
  EvaluationCallback,
  EvaluationDetails,
  EvaluationPayload,
  EvaluationReason,
  InitOptions,
} from "./types";
import { QUONFIG_SDK_LOGGING_CONTEXT_NAME } from "./types";

/**
 * Build the OpenFeature `variant` string per the cross-SDK spec
 * (project/plans/openfeature-resolution-details.md §2).
 */
const buildVariant = (
  reason: EvaluationReason,
  ruleIndex: number | undefined,
  weightedValueIndex: number | undefined
): string => {
  switch (reason) {
    case "STATIC":
      return "static";
    case "TARGETING_MATCH":
      return ruleIndex !== undefined ? `targeting:${ruleIndex}` : "targeting:0";
    case "SPLIT":
      return weightedValueIndex !== undefined ? `split:${weightedValueIndex}` : "split:0";
    case "DEFAULT":
    case "ERROR":
    default:
      return "default";
  }
};

/**
 * Build the OpenFeature `flagMetadata` map per the cross-SDK spec
 * (project/plans/openfeature-resolution-details.md §3) using node/go/java
 * camelCase keys and SHOUTY_SNAKE configType values.
 */
const buildFlagMetadata = (
  configId: string | undefined,
  configType: string | undefined,
  ruleIndex: number | undefined,
  weightedValueIndex: number | undefined,
  reason: EvaluationReason
): Record<string, unknown> => {
  const md: Record<string, unknown> = {};
  if (configId !== undefined && configId !== "") md.configId = configId;
  if (configType !== undefined) md.configType = configType.toUpperCase();
  if (
    ruleIndex !== undefined &&
    ruleIndex >= 0 &&
    (reason === "TARGETING_MATCH" || reason === "SPLIT")
  ) {
    md.ruleIndex = ruleIndex;
  }
  if (weightedValueIndex !== undefined && reason === "SPLIT") {
    md.weightedValueIndex = weightedValueIndex;
  }
  return md;
};

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
  private evaluationSummaryAggregator: EvaluationSummaryAggregator | undefined;
  private _contexts: Contexts = {};
  private _loggerKey: string | undefined;
  // Encoded signature of the context whose evaluations currently populate
  // `_configs`. Used to decide whether a 304 can be safely no-op'd: a 304 only
  // means "unchanged" for its own context, so if `_configs` holds a different
  // context (after `updateContext()`), we must still apply the 304's cached
  // payload rather than leave stale wrong-context values.
  private _loadedContextSig: string | undefined;
  private _dataVersion = 0;
  // Reject-older install guard state (qfg-7h5d.2.1, spec 5f/5f.1).
  // `_heldGeneration` is the monotonic Meta.generation of the payload currently
  // in `_configs` (0 before the first install, or when the server is
  // unversioned / the depth-1 secondary's gen=1 floor). `_configInstalls`
  // counts installs over the client's lifetime so the guard can tell a fresh
  // client (install anything) from an established one (reject-older).
  private _heldGeneration = 0;
  private _configInstalls = 0;
  private _subscribers: Set<() => void> = new Set();
  // Bootstrap (globalThis._quonfigBootstrap) is a ONE-SHOT init seed: an SSR
  // snapshot used to paint instantly on the first load() without a network
  // round-trip. Once consumed, every later load() (the poll ticks) ignores it
  // and fetches live — otherwise the stale SSR snapshot would be re-applied on
  // every tick, permanently reverting fresh data to SSR-time values and making
  // server-side flag flips invisible (qfg-xqxi).
  private _bootstrapConsumed = false;

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
    domain,
    apiUrls,
    apiUrl,
    telemetryUrl,
    timeout,
    afterEvaluationCallback = () => {},
    collectEvaluationSummaries = true,
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
      domain,
      timeout,
      collectContextMode,
      clientVersion: clientVersionString,
    });

    this._telemetryUploader = new TelemetryUploader({
      sdkKey,
      telemetryUrl,
      domain,
      timeout,
      clientVersion: clientVersionString,
    });

    this._collectEvaluationSummaries = collectEvaluationSummaries;
    if (collectEvaluationSummaries) {
      this.evaluationSummaryAggregator = new EvaluationSummaryAggregator(this, 100000);
    }

    // Flush telemetry on page unload (browser only)
    if (
      collectEvaluationSummaries &&
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      window.addEventListener("beforeunload", () => {
        this.evaluationSummaryAggregator?.sync();
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

  /**
   * Monotonic version counter that increments every time the in-memory config
   * changes (via `setConfig` or `hydrate`). Pair with `subscribe()` and
   * React's `useSyncExternalStore` to drive re-renders on poll updates.
   */
  get dataVersion(): number {
    return this._dataVersion;
  }

  /**
   * Meta.generation of the config the client is currently holding (0 before the
   * first install, or when the server predates the watermark / is the depth-1
   * secondary's gen=1 floor). A higher generation is strictly newer; the
   * reject-older guard compares against it on every network install path
   * (qfg-7h5d.2.1, spec 5f).
   */
  get heldGeneration(): number {
    return this._heldGeneration;
  }

  /**
   * Register a listener invoked synchronously after every config mutation
   * (poll fetch, `setConfig`, `hydrate`). Returns an unsubscribe function.
   *
   * Listeners must not throw — exceptions are swallowed so one bad subscriber
   * cannot break the others.
   */
  subscribe(listener: () => void): () => void {
    this._subscribers.add(listener);
    return () => {
      this._subscribers.delete(listener);
    };
  }

  private notifySubscribers(): void {
    this._dataVersion += 1;
    this._subscribers.forEach((listener) => {
      try {
        listener();
      } catch {
        // swallow — see subscribe() docs
      }
    });
  }

  // -- Core Methods --

  /**
   * Internal: load configs from server.
   */
  private async load(): Promise<void> {
    if (!this.loader) {
      throw new Error("Quonfig not initialized. Call init() first.");
    }

    // Honor the bootstrap snapshot only on the FIRST load() (init's instant
    // paint). After that it's marked consumed so polling always fetches live —
    // see _bootstrapConsumed. A context that diverges from the snapshot falls
    // through to a live fetch as before.
    if (!this._bootstrapConsumed && globalThis && (globalThis as any)._quonfigBootstrap) {
      const bootstrap = (globalThis as any)._quonfigBootstrap as QuonfigBootstrap;

      if (contextsEqual(this._contexts, bootstrap.context)) {
        this.setConfig({ evaluations: bootstrap.evaluations });
        this._loadedContextSig = encodeContexts(this._contexts);
        this._bootstrapConsumed = true;
        return;
      }
    }
    // First load() resolved a value (from bootstrap above or the live fetch
    // below) — bootstrap has served its init-time purpose and must not seed any
    // later load().
    this._bootstrapConsumed = true;

    // Ensure loader has the freshest context
    this.loader.contexts = this._contexts;
    const sig = encodeContexts(this._contexts);

    return this.loader
      .load()
      .then((result) => {
        this.applyLoaderResult(result, sig);
      })
      .finally(() => {
        if (this.pollStatus.status === "running") {
          this._pollCount += 1;
        }
      });
  }

  /**
   * Apply a loader result to the in-memory config, enforcing the reject-older
   * install guard (qfg-7h5d.2.1, spec 5f). Shared by `load()` and `poll()` so
   * the guard lives in exactly one place. `sig` is the encoded signature of the
   * context that was requested.
   *
   * Two orthogonal conditions gate an install:
   *   1. Did the server return data for us to apply? A 200 (or a 304 whose
   *      cached payload is for a DIFFERENT context than `_configs` currently
   *      holds, after an `updateContext`) does; a 304 for the already-held
   *      context is a no-op.
   *   2. Is the data new enough to install? A SAME-context refresh runs through
   *      `shouldInstall` — the reject-older watermark check that stops a slow
   *      primary or a failover to the stale (gen=1) secondary from regressing or
   *      flapping an established client. A context SWITCH is a different query
   *      whose generation is not comparable to the held one, so it always
   *      installs (the "fresh for this context" case — a stale secondary may
   *      seed it, bounded, exactly as the spec allows; the guard must never
   *      strand `updateContext` on the held generation).
   */
  private applyLoaderResult(result: LoaderResult, sig: string): void {
    const contextChanged = this._loadedContextSig !== sig;
    if (!result.notModified || contextChanged) {
      if (contextChanged || this.shouldInstall(result.payload)) {
        this.setConfig(result.payload);
        this._loadedContextSig = sig;
      }
    }
  }

  /**
   * Canonical reject-older rule for a SAME-context network install (mirrors
   * sdk-node/src/quonfig.ts:1251 `shouldInstall`). Reject-older is the whole
   * rule — there is no source ranking (spec 5f point 2):
   *
   *   - A fresh client (nothing installed yet) accepts the first snapshot, even
   *     an unversioned or stale-secondary one — it has nothing to regress.
   *   - An incoming generation <= 0 (absent, or a server that predates the
   *     watermark) carries no ordering information, so it cannot be rejected as
   *     "older": install it (the carve-out). This is mandatory from day one so
   *     the frontend never repeats the backend's 5-of-6 miss where established
   *     clients froze against gen=0 servers (qfg-7h5d.1.18).
   *   - Otherwise install iff the incoming generation strictly exceeds the held
   *     one. Equal-or-lower is a no-op, so a late failover can't move an
   *     established client backward, an equal second leg can't flap, and a later
   *     newer leg heals forward.
   *
   * The depth-1 secondary's generation is a positive 1, so it is rejected by the
   * strict-greater check (an established client holds a far higher primary
   * generation, so `1 > held` is false — spec 5f.1), NOT by the carve-out. Only
   * a truly unversioned (<= 0) payload takes the carve-out.
   */
  private shouldInstall(payload: EvaluationPayload): boolean {
    if (this._configInstalls === 0) return true;
    const incoming = payload?.meta?.generation ?? 0;
    if (incoming <= 0) return true;
    return incoming > this._heldGeneration;
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

    const sig = encodeContexts(this._contexts);
    return this.loader
      .load()
      .then((result) => {
        // First poll fetch. Same guarded install path as load() — see
        // applyLoaderResult for the 304/context-switch and reject-older rules.
        this.applyLoaderResult(result, sig);
      })
      .finally(() => {
        // Schedule the recurring loop REGARDLESS of the first fetch's outcome
        // (qfg-8uw5). If the bootstrap fetch rejects — a startup network blip
        // with both primary and secondary briefly unreachable — `.then` never
        // runs, so scheduling here is the only thing that lets polling start and
        // self-heal on the next tick. `doPolling`'s own loop is already resilient
        // this way; the bootstrap must match it. (The legacy ReforgeHQ SDK
        // scheduled here too; the Quonfig port regressed it into the `.then`.)
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
    await this.evaluationSummaryAggregator?.sync();
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
  }

  /**
   * Set configs from a raw evaluation payload. This is the single install
   * mutation every network path funnels through; it stamps the held generation
   * watermark and bumps the install count so the reject-older guard
   * (`shouldInstall`) can order the next install. Callers on a network path go
   * through `applyLoaderResult`, which enforces the guard first; `setConfig`
   * itself installs unconditionally (a local SSR `hydrate`/bootstrap seed is a
   * source of truth and intentionally skips the guard).
   */
  setConfig(rawValues: EvaluationPayload) {
    this._configs = Config.digest(rawValues);
    this._heldGeneration = rawValues?.meta?.generation ?? 0;
    this._configInstalls += 1;
    this.loaded = true;
    this.notifySubscribers();
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
    this.notifySubscribers();
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
        // qfg-5jcd: record synchronously. record() is a Map.set + counter
        // increment with no I/O; deferring it via setTimeout(0) caused a tight
        // sync get()-loop followed by await close() to race past the records
        // and ship empty telemetry. Matches sdk-node/src/quonfig.ts.
        this.evaluationSummaryAggregator?.record(config);
      }
      // afterEvaluationCallback is user-supplied — keep it deferred so a
      // throwing or slow callback can't block the calling get().
      setTimeout(() => this.afterEvaluationCallback(key, value, this._contexts));
    }

    return value;
  }

  /**
   * Return the evaluated value plus OpenFeature-style resolution details
   * (reason, variant, flagMetadata) for the given key.
   *
   * Mirrors sdk-node's `getBoolDetails` / `getStringDetails` etc. so the
   * openfeature-web provider can populate `variant` and `flagMetadata` per
   * `project/plans/openfeature-resolution-details.md`.
   */
  getDetails<T = ConfigValue>(key: string): EvaluationDetails<T> {
    if (!this.loaded) {
      return {
        value: undefined,
        reason: "ERROR",
        errorCode: "GENERAL",
        errorMessage: "Quonfig client has not finished loading",
        variant: "default",
        flagMetadata: {},
      };
    }

    const config = this.configs[key];
    if (!config) {
      return {
        value: undefined,
        reason: "ERROR",
        errorCode: "FLAG_NOT_FOUND",
        errorMessage: `No config found for key "${key}"`,
        variant: "default",
        flagMetadata: {},
      };
    }

    const md = config.configEvaluationMetadata;
    // Older api-delivery deployments don't emit `reason` on the wire; treat
    // their absence as STATIC so consumers see a sensible variant string.
    const reason: EvaluationReason = md?.reason ?? "STATIC";
    const ruleIndex = md?.ruleIndex;
    const weightedValueIndex = md?.weightedValueIndex;

    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      if (this._collectEvaluationSummaries) {
        this.evaluationSummaryAggregator?.record(config);
      }
      setTimeout(() => this.afterEvaluationCallback(key, config.value, this._contexts));
    }

    return {
      value: config.value as unknown as T,
      reason,
      variant: buildVariant(reason, ruleIndex, weightedValueIndex),
      flagMetadata: buildFlagMetadata(
        md?.configId,
        md?.configType,
        ruleIndex,
        weightedValueIndex,
        reason
      ),
    };
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
  shouldLog(args: { configKey: string; desiredLevel: string; defaultLevel: string }): boolean;
  shouldLog(args: { loggerPath: string; desiredLevel: string; defaultLevel?: string }): boolean;
  shouldLog(args: {
    configKey?: string;
    loggerPath?: string;
    desiredLevel: string;
    defaultLevel?: string;
  }): boolean {
    let resolvedConfigKey: string;
    // Default fallback matches sdk-node (WARN).
    let resolvedDefaultLevel = args.defaultLevel ?? "WARN";

    if (args.loggerPath !== undefined) {
      if (args.configKey !== undefined) {
        throw new Error("[quonfig] shouldLog: pass either `configKey` or `loggerPath`, not both.");
      }
      if (!this._loggerKey) {
        throw new Error(
          "[quonfig] shouldLog({loggerPath}) requires the `loggerKey` option on quonfig.init(). " +
            'Pass `loggerKey: "log-level.<your-app>"` or use the `configKey` form instead.'
        );
      }
      resolvedConfigKey = this._loggerKey;

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
    } else {
      throw new Error("[quonfig] shouldLog requires either `configKey` or `loggerPath`.");
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
}

/** Singleton instance for convenience. */
export const quonfig = new Quonfig();
