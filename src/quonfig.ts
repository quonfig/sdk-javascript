import { v4 as uuid } from "uuid";

import { Config, isDuration } from "./config";
import { contextsEqual, encodeContexts, validateContexts } from "./context";
import { EvaluationSummaryAggregator } from "./telemetry/evaluationSummaryAggregator";
import Loader, { type AuthRejection, type LoaderResult, safeErrorText } from "./loader";
import { DEFAULT_TIMEOUT, DEFAULT_HEDGE_DELAY } from "./apiHelpers";
import { writeLkg } from "./lkgCache";
import { shouldLog } from "./logger";
import { consoleLogger, normalizeLogger, type NormalizedLogger } from "./sdkLogger";
import { QuonfigInitError } from "./initError";

const LOG_LEVEL_KEY_PREFIX = "log-level";
// Telemetry debug lines print only when this log-level config evaluates to
// DEBUG (or lower), the same gate the SDK's internal debug logging always used.
const TELEMETRY_LOG_LEVEL_KEY = "log-level.quonfig-javascript.quonfig.telemetry";
import TelemetryUploader from "./telemetry/uploader";
import { TelemetryReporter, resolveTelemetryConfig } from "./telemetry/reporter";
import type { TelemetryLogger } from "./telemetry/transportQueue";
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
  OnInitFailure,
} from "./types";

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

/**
 * Infer a Config type for a hydrated (flat, already-parsed) value, e.g. the
 * output of extract(): a { ms, seconds } object is a duration, a string array
 * a string_list, any other object json.
 */
// Cap on distinct Configs buffered before init(); reads of Configs already
// buffered keep counting (qfg-27wr).
const PRE_INIT_READS_MAX = 10_000;

/** Stable comparison key for a config value (hydrated vs network). */
const valueSignature = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
};

const hydratedType = (value: unknown): string => {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (isDuration(value)) return "duration";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return "string_list";
  if (typeof value === "object" && value !== null) return "json";
  return "string";
};

/**
 * A per-instance id for telemetry dedupe. uuid() needs
 * crypto.getRandomValues, which some runtimes lack (React Native without its
 * polyfill, some embedded webviews); this id needs no cryptographic strength,
 * so fall back to Math.random rather than throw. crypto.randomUUID is not an
 * option: it is undefined on insecure (plain http) pages.
 */
const newInstanceHash = (): string => {
  try {
    return uuid();
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
};

// While auth-failed, each poll waits max(T, frequencyInMs) with T uniform in
// [150s, 300s], re-drawn every time (plan 2026-10-07-sdk-auth-failure-rule R3).
const AUTH_PROBE_MIN_MS = 150_000;
const AUTH_PROBE_SPAN_MS = 150_000;
const authProbeWaitMs = (): number =>
  AUTH_PROBE_MIN_MS + Math.floor(Math.random() * AUTH_PROBE_SPAN_MS);

/** Default overall init deadline for a client SDK (design doc A.1). */
export const DEFAULT_INIT_TIMEOUT = 5000;
const INIT_FAILURE_MODES: ReadonlySet<string> = new Set(["fail", "wait", "continue"]);
// Init/background retry backoff: 0.5s, 1s, 2s, 4s, ... capped at 30s, +/-20%
// jitter (design doc B.3).
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30_000;
const retryDelayMs = (attempt: number): number => {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4));
};
// Progress cadence (design doc C): every 5s until the timeout, every 30s while
// `wait` blocks past it. While not ready after init settles: every 30s for the
// first 5 minutes, then every 5 minutes.
const INIT_PROGRESS_MS = 5_000;
const WAIT_PROGRESS_MS = 30_000;
const BACKGROUND_LOG_EARLY_MS = 30_000;
const BACKGROUND_LOG_LATE_MS = 300_000;
const BACKGROUND_LOG_SWITCH_MS = 300_000;

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const wholeSecs = (ms: number): string => `${Math.round((ms / 1000) * 10) / 10}s`;
const minsSecs = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m${total % 60}s` : `${total}s`;
};
// Age of a cached copy for the "cached config from <age> ago" line.
const ageLabel = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${Math.floor((total % 3_600) / 60)}m`;
  return minsSecs(total * 1000);
};
const unrefTimer = (t: ReturnType<typeof setTimeout>) => {
  (t as unknown as { unref?: () => void }).unref?.();
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
  // No prototype: a key like "constructor" must not resolve to Object.prototype.
  private _configs: { [key: string]: Config } = Object.create(null);
  private _telemetryUploader: TelemetryUploader | undefined;
  private _pollCount = 0;
  private _pollStatus: PollStatus = { status: "not-started" };
  private _pollTimeoutId: ReturnType<typeof setTimeout> | undefined;
  // True while poll ticks are failing; gates the once-per-outage warning.
  private _pollOutage = false;
  // True after a poll cycle in which every leg failed and the primary answered
  // 401/403/404/410 (auth-failed). Polls then slow to max(T, frequencyInMs)
  // until a 200/304 on any leg. Kept across stopPolling()/poll().
  private _authFailed = false;
  // Bumped by every stopPolling() (and so every poll()). A poll loop keeps
  // rescheduling only while its generation is current, so a stop or a newer
  // poll() during an in-flight fetch can't leave a second, unstoppable loop.
  private _pollGeneration = 0;
  // Created on first read, not at construction: the module-level singleton
  // would otherwise call uuid() at import time (see newInstanceHash).
  private _instanceHash: string | undefined;
  private _collectEvaluationSummaries = true;
  private evaluationSummaryAggregator: EvaluationSummaryAggregator | undefined;
  // qfg-27wr: Configs built by hydrate() carry no evaluation metadata, so the
  // aggregator cannot record them. Reads of them are held here, per key with
  // a count (bounded by the hydrated key set), and recorded against the first
  // network Config installed for that key when its value matches.
  private _hydratedConfigs: WeakSet<Config> = new WeakSet();
  private _heldHydratedReads: Map<string, { sig: string; count: number }> = new Map();
  // Reads made before init() wires telemetry, per Config with a count; drained
  // (recorded + afterEvaluationCallback) once init() installs both.
  private _telemetryWired = false;
  private _preInitReads: Map<Config, number> = new Map();
  private telemetryReporter: TelemetryReporter | undefined;
  private pageHideListener: (() => void) | undefined;
  private _contexts: Contexts = {};
  private _loggerKey: string | undefined;
  // Every SDK log line goes through this (qfg-qgnw). `console` until init()
  // installs the caller's `logger` option.
  private _logger: NormalizedLogger = consoleLogger;
  // True when init() was given a `logger` (Config.digest keeps its historical
  // console.trace otherwise).
  private _customLogger = false;
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
  // unversioned / pre-watermark). `_configInstalls`
  // counts installs over the client's lifetime so the guard can tell a fresh
  // client (install anything) from an established one (reject-older).
  private _heldGeneration = 0;
  private _configInstalls = 0;
  // True when the currently-installed config came from the last-known-good
  // localStorage cache because every API URL was unreachable (spec 5h). Any
  // fresh network install clears it. Surfaced via the `stale` getter and
  // getDetails reason STALE.
  private _stale = false;
  // True between a context switch that cleared the served config (no cached
  // copy for the new context) and the next install (qfg-xiub).
  private _awaitingSwitchedContext = false;
  // When the cached last-known-good copy being served was written (epoch ms),
  // if known: names its age in the section C start line.
  private _cacheSavedAt: number | undefined;
  private _subscribers: Set<() => void> = new Set();
  // Bootstrap (globalThis._quonfigBootstrap) is a ONE-SHOT init seed: an SSR
  // snapshot used to paint instantly on the first load() without a network
  // round-trip. Once consumed, every later load() (the poll ticks) ignores it
  // and fetches live — otherwise the stale SSR snapshot would be re-applied on
  // every tick, permanently reverting fresh data to SSR-time values and making
  // server-side flag flips invisible (qfg-xqxi).
  private _bootstrapConsumed = false;
  // Readiness (design doc B.4): true once a live network answer (or an SSR
  // bootstrap) for the current context has been installed or confirmed. A
  // served last-known-good copy is config but not ready (it is stale).
  private _ready = false;
  // The QuonfigInitError the latest init() rejected with; cleared on heal.
  private _initError: QuonfigInitError | undefined;
  // Bumped by every init(); an older init's retry loop stops when it changes.
  private _initGeneration = 0;
  // Init/background retry loop. Bumped by stopInitRetry() (poll(), close(),
  // a re-init) so an in-flight attempt cannot reschedule. stopPolling() does
  // not stop it; it resumes a loop that poll() paused.
  private _retryGeneration = 0;
  private _retryTimeoutId: ReturnType<typeof setTimeout> | undefined;
  // Section C background-retry WARN cadence, independent of the retry backoff.
  private _backgroundLogTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private _initStartedAt = 0;
  // True once an init attempt failed, so the heal logs "init recovered".
  private _initFailedOnce = false;
  // Settles a still-pending init() when readiness arrives from any path (a
  // poll tick, updateContext), not only from the init retry loop.
  private _onReady: (() => void) | undefined;
  // Resumes the latest init's retry loop after poll() paused it, when
  // stopPolling() ends the poll loop before the client is ready.
  private _resumeInitRetry: (() => void) | undefined;
  // The latest init()'s promise. A superseded init() settles with it, as a
  // superseded load settles with the load that replaced it.
  private _latestInit: Promise<void> | undefined;

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
    hedgeDelay,
    onInitFailure,
    initTimeout,
    afterEvaluationCallback = () => {},
    collectEvaluationSummaries = true,
    collectContextMode = "PERIODIC_EXAMPLE",
    loggerKey,
    logger,
    telemetryFlushIntervalMs,
    telemetryTimeoutMs,
    telemetryMaxRetainedBatches,
    telemetryMaxRetainedBytes,
    telemetryMaxRetainedAgeMs,
    telemetryMaxEvaluationSummaries,
  }: InitOptions): Promise<void> {
    if (!context) {
      throw new Error("Context must be provided");
    }

    this._logger = normalizeLogger(logger);
    this._customLogger = logger !== undefined;
    validateContexts(context, this._logger);
    this._contexts = context;
    this._loggerKey = loggerKey;

    // Accept singular `apiUrl` as an alias for `apiUrls`. `apiUrls` wins if both
    // are provided. Mirrors the normalization @quonfig/react already does on
    // its provider props (qfg-f4g) so a staging caller passing the singular
    // form doesn't silently fall back to the prod default URLs.
    const resolvedApiUrls = apiUrls ?? (apiUrl ? [apiUrl] : undefined);

    const clientVersionString = `${this.clientName}-${this.clientVersion}`;

    // Invariant: the per-leg fetch `timeout` must stay ABOVE `hedgeDelay`
    // (spec 5e). If timeout <= hedgeDelay the primary leg is aborted before the
    // hedge timer can fire the secondary in parallel, so the parallel hedge
    // silently degrades to error-only sequential failover — the secondary is
    // contacted only after the primary fully times out, never concurrently with
    // a still-alive-but-slow primary. Warn (with the effective values) rather
    // than fail so an over-tight timeout is visible instead of silent.
    const effectiveTimeout = timeout || DEFAULT_TIMEOUT;
    const effectiveHedgeDelay = hedgeDelay ?? DEFAULT_HEDGE_DELAY;
    if (effectiveTimeout <= effectiveHedgeDelay) {
      this._logger.warn(
        `Quonfig: timeout (${effectiveTimeout}ms) is not above hedgeDelay (${effectiveHedgeDelay}ms). ` +
          `The primary leg is aborted before the parallel hedge can fire, degrading the hedge to ` +
          `error-only failover (the secondary is only tried after the primary fully times out, not ` +
          `in parallel). Set timeout above hedgeDelay to keep the hedge parallel.`
      );
    }

    // A single explicit API URL disables automatic failover. The default (and
    // every `domain` / `QUONFIG_DOMAIN`-derived) URL list carries BOTH a
    // primary and a secondary leg, and the SDK hedges/fails over between them
    // (spec 5e). An explicit `apiUrls` (or the singular `apiUrl` alias)
    // replaces that list wholesale, so a one-entry override silently drops the
    // secondary. `resolvedApiUrls` is undefined when the caller supplied
    // neither, so the default two-leg list never triggers this. Warn once at
    // init so the lost failover is visible instead of silent.
    if (resolvedApiUrls !== undefined && resolvedApiUrls.length < 2) {
      this._logger.warn(
        "Quonfig: explicit apiUrls disables automatic failover to the secondary; " +
          "pass both primary and secondary URLs to keep it"
      );
    }

    this.loader = new Loader({
      sdkKey,
      contexts: context,
      apiUrls: resolvedApiUrls,
      domain,
      timeout,
      hedgeDelay,
      collectContextMode,
      clientVersion: clientVersionString,
    });

    const telemetryConfig = resolveTelemetryConfig({
      flushIntervalMs: telemetryFlushIntervalMs,
      timeoutMs: telemetryTimeoutMs,
      maxRetainedBatches: telemetryMaxRetainedBatches,
      maxRetainedBytes: telemetryMaxRetainedBytes,
      maxRetainedAgeMs: telemetryMaxRetainedAgeMs,
      maxEvaluationSummaries: telemetryMaxEvaluationSummaries,
    });

    // The telemetry deadline is its own option: the eval-fetch `timeout`
    // (3s, tuned for read latency) no longer reaches telemetry (qfg-y8je.11).
    this._telemetryUploader = new TelemetryUploader({
      sdkKey,
      telemetryUrl,
      domain,
      timeout: telemetryConfig.timeoutMs,
      clientVersion: clientVersionString,
      logger: this._logger,
    });

    // A re-init replaces the reporter; stop the old one so its timer and
    // pagehide listener do not leak.
    this.teardownTelemetry();

    this._collectEvaluationSummaries = collectEvaluationSummaries;
    if (collectEvaluationSummaries) {
      this.evaluationSummaryAggregator = new EvaluationSummaryAggregator(
        this,
        telemetryConfig.maxEvaluationSummaries
      );
      this.telemetryReporter = new TelemetryReporter({
        uploader: this._telemetryUploader,
        aggregator: this.evaluationSummaryAggregator,
        logger: this.telemetryLogger(),
        config: telemetryConfig,
      });
      this.telemetryReporter.start();

      // Final flush when the page goes away (browser only). pagehide, not
      // beforeunload: it fires on mobile and on back/forward-cache navigations.
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        const reporter = this.telemetryReporter;
        this.pageHideListener = () => reporter.onPageHide();
        window.addEventListener("pagehide", this.pageHideListener);
      }
    }

    this.afterEvaluationCallback = afterEvaluationCallback;
    this._telemetryWired = true;
    this.flushPreInitReads();

    let mode: OnInitFailure = "fail";
    if (onInitFailure !== undefined) {
      if (INIT_FAILURE_MODES.has(onInitFailure)) {
        mode = onInitFailure;
      } else {
        this._logger.warn(
          `[quonfig] unknown onInitFailure "${String(onInitFailure)}"; using "fail". ` +
            `Valid values: "fail", "wait", "continue".`
        );
      }
    }
    // initTimeout <= 0 means one attempt, then the policy (design doc
    // decision 8), so negatives (including -Infinity) clamp to 0. NaN, +Infinity
    // and non-numbers fall back to the default with a warning.
    let effectiveInitTimeout = DEFAULT_INIT_TIMEOUT;
    if (typeof initTimeout === "number" && !Number.isNaN(initTimeout) && initTimeout <= 0) {
      effectiveInitTimeout = 0;
    } else if (typeof initTimeout === "number" && Number.isFinite(initTimeout)) {
      effectiveInitTimeout = initTimeout;
    } else if (initTimeout !== undefined) {
      this._logger.warn(
        `[quonfig] invalid initTimeout ${String(initTimeout)}; using ${DEFAULT_INIT_TIMEOUT}ms. ` +
          `Pass a finite number of ms (0 or less = one attempt, then onInitFailure).`
      );
    }

    return this.runInit(mode, effectiveInitTimeout);
  }

  /**
   * The init retry loop (design doc B.3). Attempts a hedged load, retrying with
   * backoff until config arrives. The returned promise settles:
   *   - resolved on the first live answer or cached last-known-good copy (a
   *     cache counts as config in every mode);
   *   - at `initTimeout` per `mode`: `fail` rejects with QuonfigInitError,
   *     `continue` resolves on code defaults, `wait` keeps waiting. With
   *     `initTimeout <= 0` the policy applies once the first attempt fails;
   *   - at once under `fail` (reject) or `continue` when every leg rejects the
   *     key (401/403/404/410).
   * The same loop keeps running in the background after it settles, until the
   * client is ready, so no client is left permanently dead.
   */
  private runInit(mode: OnInitFailure, initTimeout: number): Promise<void> {
    this.stopInitRetry();
    this._initGeneration += 1;
    const initGeneration = this._initGeneration;
    // The retry generation this loop runs under. poll() pauses the loop by
    // bumping this._retryGeneration; stopPolling() resumes it under a new one.
    let loopGeneration = this._retryGeneration;
    const startedAt = Date.now();
    this._initStartedAt = startedAt;
    this._ready = false;
    this._initError = undefined;
    this._initFailedOnce = false;
    const timeoutLabel = wholeSecs(initTimeout);

    this._logger.debug(
      `[quonfig] init: fetching config (initTimeout=${timeoutLabel}, onInitFailure=${mode})`
    );

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let attempt = 0;
      // Decision 7: the reason is "timeout" iff the LAST attempt hung (every
      // leg in it ended on a timeout) or none completed. `attemptInFlight`
      // with `inFlightFastFailure` describes an attempt the deadline catches
      // mid-flight (its pending legs count as hung, as the deadline would cut
      // them); `lastAttemptHung` describes the last completed one.
      let attemptsCompleted = 0;
      let lastAttemptHung = false;
      let attemptInFlight = false;
      let inFlightFastFailure = false;
      let lastError: unknown;
      let lastErrs = "";
      let authLogged = false;
      let nextProgressAt = startedAt + INIT_PROGRESS_MS;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      // initTimeout <= 0: the policy applies once, after the first attempt.
      let oneAttemptPolicyApplied = false;

      const current = () => initGeneration === this._initGeneration;
      const looping = () => current() && loopGeneration === this._retryGeneration;
      const errsPart = () => (lastErrs ? ` ${lastErrs}.` : "");

      // A newer init() replaced this one: stop and settle with it.
      const followNewer = () => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        this._latestInit?.then(resolve, reject);
      };

      // Background-retry WARN (section C): every 30s for the first 5 min after
      // start, then every 5 min, while the settled client is still not ready.
      // A timer of its own, so the cadence does not stretch with the retry
      // backoff (which grows toward its cap between attempts).
      const scheduleBackgroundLog = () => {
        const interval =
          Date.now() - startedAt < BACKGROUND_LOG_SWITCH_MS
            ? BACKGROUND_LOG_EARLY_MS
            : BACKGROUND_LOG_LATE_MS;
        this._backgroundLogTimeoutId = setTimeout(() => {
          this._backgroundLogTimeoutId = undefined;
          if (!looping() || this._ready) return;
          this._logger.warn(
            `[quonfig] still not connected to Quonfig delivery (${minsSecs(Date.now() - startedAt)} since start); ` +
              `serving ${this._stale ? "cache" : "defaults"}.${errsPart()}`
          );
          scheduleBackgroundLog();
        }, interval);
        unrefTimer(this._backgroundLogTimeoutId);
      };

      const finish = (error?: QuonfigInitError) => {
        if (settled) return;
        settled = true;
        if (!this._ready && looping()) scheduleBackgroundLog();
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        if (error) {
          this._initError = error;
          this.notifySubscribers();
          reject(error);
        } else {
          resolve();
        }
      };

      this._onReady = () => {
        if (current()) finish();
      };

      const scheduleNext = (authRejected: boolean) => {
        if (!looping() || this._ready) return;
        let delay = retryDelayMs(attempt);
        // A rejected key is probed slowly once init has settled (the same
        // 150-300s cadence the poll loop uses while auth-failed).
        if (authRejected && settled) delay = Math.max(delay, authProbeWaitMs());
        this._retryTimeoutId = setTimeout(attemptOnce, delay);
        // Once init has settled this is a background retry: it must not keep a
        // Node process (SSR, tests) alive on its own.
        if (settled) unrefTimer(this._retryTimeoutId);
      };

      const onFailedAttempt = (error: unknown, rejection: AuthRejection | undefined) => {
        lastError = error;
        const now = Date.now();
        const elapsed = now - startedAt;

        if (!settled) {
          if (attempt === 1) {
            this._initFailedOnce = true;
          }
          // With initTimeout <= 0 the policy line below (onDeadline) is the
          // first-failure line, so the "retrying until initTimeout" WARN is
          // skipped.
          if (attempt === 1 && initTimeout > 0) {
            this._logger.warn(
              `[quonfig] init: config not loaded yet, retrying until initTimeout (${timeoutLabel}).${errsPart()}`
            );
          } else if (attempt > 1 && now >= nextProgressAt) {
            const timedOut = elapsed >= initTimeout;
            this._logger.warn(
              timedOut
                ? `[quonfig] init: still blocked waiting for config (${minsSecs(elapsed)} elapsed, attempt ${attempt}).${errsPart()}`
                : `[quonfig] init: still waiting for config (${secs(elapsed)} elapsed of ${timeoutLabel}, attempt ${attempt}).${errsPart()}`
            );
            while (nextProgressAt <= now) {
              nextProgressAt += timedOut ? WAIT_PROGRESS_MS : INIT_PROGRESS_MS;
            }
          }

          // Decision 6: only when EVERY configured leg rejected the key.
          if (rejection?.allLegs && !authLogged) {
            authLogged = true;
            const legs =
              (this.loader?.apiUrls.length ?? 1) > 1 ? "primary and secondary" : "primary";
            const head = `SDK key rejected (${rejection.status}) by ${legs}. Check the key and environment.`;
            if (mode === "fail") {
              const message = `[quonfig] init FAILED: ${head} onInitFailure=fail: raising now.`;
              this._logger.error(message);
              finish(new QuonfigInitError("unauthorized", message, error));
            } else if (mode === "continue") {
              this._logger.warn(
                `[quonfig] init: ${head} onInitFailure=continue: STARTING ON CODE DEFAULTS. Retrying in background.`
              );
              finish();
            } else {
              // Client SDKs log ERROR only under fail (design doc section C).
              this._logger.warn(
                `[quonfig] init: ${head} onInitFailure=wait: still blocking startup and retrying.`
              );
            }
          }
        }
      };

      const attemptOnce = () => {
        if (!looping() || this._ready) return;
        attempt += 1;
        // This attempt's own generation: a resumed loop (stopPolling after
        // poll) runs under a newer one, so a stale attempt cannot reschedule.
        const generation = loopGeneration;
        const live = () => current() && generation === this._retryGeneration;
        let rejection: AuthRejection | undefined;
        let legErrs: string | undefined;
        let fastFailure = false;
        let legFailures = 0;
        attemptInFlight = true;
        inFlightFastFailure = false;
        const completed = () => {
          if (generation !== loopGeneration) return;
          attemptInFlight = false;
          // An attempt a poll() superseded reports no legs of its own; it
          // tells nothing about how the network failed.
          if (legFailures === 0) return;
          attemptsCompleted += 1;
          lastAttemptHung = !fastFailure;
        };
        this.load(
          (r) => {
            rejection = r;
          },
          undefined,
          (errs) => {
            legErrs = errs;
          },
          (timedOut) => {
            legFailures += 1;
            if (!timedOut) {
              fastFailure = true;
              if (generation === loopGeneration) inFlightFastFailure = true;
            }
          }
        ).then(
          () => {
            completed();
            if (!current()) return followNewer();
            if (!live()) {
              // A poll() superseded this attempt and settled it with its own
              // load: that load was the one attempt.
              applyOneAttemptPolicy();
              return;
            }
            if (this._ready) {
              finish();
              return;
            }
            // Resolved without readiness: the last-known-good copy was served
            // (every leg failed). That is config, so init resolves; keep
            // retrying for a live answer in the background.
            if (legErrs) lastErrs = legErrs;
            if (!settled) {
              this._initFailedOnce = true;
              // Section C: starting on the cache is a degraded start and must
              // be visible above DEBUG. Logged once; later cache-fallback
              // attempts are covered by the background "serving cache" WARN.
              if (this._stale) {
                this._logger.warn(
                  `[quonfig] init: config not loaded from delivery. onInitFailure=${mode}: ` +
                    `STARTING ON ${this.cachedConfigLabel()}. This instance may disagree with the rest ` +
                    `of your fleet. Retrying in background.${errsPart()}`
                );
              }
              finish();
            }
            scheduleNext(rejection !== undefined);
          },
          (error) => {
            completed();
            if (!current()) return followNewer();
            if (!live()) {
              if (legErrs) lastErrs = legErrs;
              lastError = error;
              applyOneAttemptPolicy();
              return;
            }
            lastErrs = legErrs || safeErrorText(error);
            onFailedAttempt(error, rejection);
            // initTimeout <= 0: one attempt, then the policy (decision 8).
            applyOneAttemptPolicy();
            scheduleNext(rejection !== undefined);
          }
        );
      };

      // Resume a loop that poll() paused, after stopPolling() (a pending
      // init() must never be left without a retry loop).
      this._resumeInitRetry = () => {
        if (!current() || this._ready || looping()) return;
        this._retryGeneration += 1;
        loopGeneration = this._retryGeneration;
        attemptInFlight = false;
        if (settled) scheduleBackgroundLog();
        scheduleNext(false);
      };

      const onDeadline = () => {
        deadlineTimer = undefined;
        if (!current()) return followNewer();
        if (settled || this._ready) return;
        const elapsed = secs(Date.now() - startedAt);
        // An attempt still in flight (a hanging network) has not reached the
        // cached copy yet. A cache counts as config in every mode, so start on
        // it now rather than on code defaults (or a rejection).
        if (this.installCachedCopy()) {
          this._initFailedOnce = true;
          this._logger.warn(
            `[quonfig] init: no config after ${elapsed}. onInitFailure=${mode}: STARTING ON ` +
              `${this.cachedConfigLabel()}. This instance may disagree with the rest of your fleet. ` +
              `Retrying in background.`
          );
          finish();
          return;
        }
        if (mode === "fail") {
          const message =
            `[quonfig] init FAILED: no config after ${elapsed}.${errsPart()} onInitFailure=fail: ` +
            `raising QuonfigInitError. Options: onInitFailure=wait to keep waiting, ` +
            `onInitFailure=continue to start on code defaults, or raise initTimeout.`;
          this._logger.error(message);
          // The deadline cuts an attempt in flight, as sdk-go's does: that one
          // is the last attempt, and its pending legs hung.
          const hung = attemptInFlight
            ? !inFlightFastFailure
            : attemptsCompleted === 0 || lastAttemptHung;
          finish(new QuonfigInitError(hung ? "timeout" : "unavailable", message, lastError));
        } else if (mode === "continue") {
          this._logger.warn(
            `[quonfig] init: no config after ${elapsed}. onInitFailure=continue: STARTING ON CODE DEFAULTS. ` +
              `This instance may disagree with the rest of your fleet. Retrying in background.`
          );
          finish();
        } else {
          this._logger.warn(
            `[quonfig] init: no config after ${elapsed}. onInitFailure=wait: still blocking startup and ` +
              `retrying indefinitely.${errsPart()} Use onInitFailure=fail or continue to bound startup.`
          );
          nextProgressAt = Date.now() + WAIT_PROGRESS_MS;
        }
      };
      // initTimeout <= 0 (decision 8): no timer; the policy applies once the
      // first attempt ends, including one a poll() superseded.
      const applyOneAttemptPolicy = () => {
        if (initTimeout > 0 || oneAttemptPolicyApplied || settled) return;
        oneAttemptPolicyApplied = true;
        onDeadline();
      };
      if (initTimeout > 0) deadlineTimer = setTimeout(onDeadline, initTimeout);

      attemptOnce();
    });
    this._latestInit = promise;
    return promise;
  }

  /**
   * Install the cached last-known-good copy for the current context (stale),
   * if one exists and nothing live is held. Returns whether the client now
   * serves the cache.
   */
  private installCachedCopy(): boolean {
    if (!this.loader || this._ready) return false;
    if (!this._stale) {
      const cached = this.loader.readLastKnownGood(this._contexts);
      if (!cached) return false;
      this.applyLoaderResult(
        { notModified: false, payload: cached.payload, stale: true, savedAt: cached.savedAt },
        encodeContexts(this._contexts)
      );
    }
    return this._stale;
  }

  /** "CACHED CONFIG from <age> ago", or "(age unknown)" for a copy written without a timestamp. */
  private cachedConfigLabel(): string {
    return this._cacheSavedAt === undefined
      ? "CACHED CONFIG (age unknown)"
      : `CACHED CONFIG from ${ageLabel(Date.now() - this._cacheSavedAt)} ago`;
  }

  /** Stop the init/background retry loop (it does not settle a pending init()). */
  private stopInitRetry(): void {
    this._retryGeneration += 1;
    if (this._retryTimeoutId) {
      clearTimeout(this._retryTimeoutId);
      this._retryTimeoutId = undefined;
    }
    if (this._backgroundLogTimeoutId) {
      clearTimeout(this._backgroundLogTimeoutId);
      this._backgroundLogTimeoutId = undefined;
    }
  }

  /**
   * Readiness flips true on the first live answer for the current context
   * (from any path: init's retry loop, a poll tick, updateContext). Clears the
   * init error, logs the heal when init had failed, stops the retry loop and
   * settles a still-pending init().
   */
  private markReady(via?: { leg?: string; version?: string }): void {
    if (this._ready) return;
    this._ready = true;
    this._initError = undefined;
    this.stopInitRetry();
    if (this._initFailedOnce) {
      this._initFailedOnce = false;
      const elapsed = secs(Date.now() - this._initStartedAt);
      const leg = via?.leg ? ` via ${via.leg}` : "";
      const version = via?.version
        ? ` (version ${via.version})`
        : this._heldGeneration > 0
          ? ` (generation ${this._heldGeneration})`
          : "";
      this._logger.info(
        `[quonfig] init recovered: config loaded after ${elapsed}${leg}${version}. Now serving live config.`
      );
    }
    const onReady = this._onReady;
    this._onReady = undefined;
    onReady?.();
  }

  /**
   * Whether the client holds live config: a network answer (or an SSR
   * bootstrap) for the current context. False before the first answer, while
   * serving a cached last-known-good copy, and after a failed init until the
   * background retry (or `poll()`) heals it.
   */
  isReady(): boolean {
    return this._ready;
  }

  /**
   * The `QuonfigInitError` the latest `init()` rejected with
   * (`onInitFailure: "fail"`), or undefined. Cleared when the client heals.
   */
  get error(): QuonfigInitError | undefined {
    return this._initError;
  }

  // -- Accessors --

  get configs(): { [key: string]: Config } {
    return this._configs;
  }

  get contexts(): Contexts {
    return this._contexts;
  }

  get instanceHash(): string {
    if (this._instanceHash === undefined) {
      this._instanceHash = newInstanceHash();
    }
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
   * first install, or when the server predates the watermark). A higher
   * generation is strictly newer; the reject-older guard compares against it on
   * every network install path (qfg-7h5d.2.1, spec 5f).
   */
  get heldGeneration(): number {
    return this._heldGeneration;
  }

  /**
   * Whether the currently-served config came from the last-known-good
   * localStorage cache because every API URL was unreachable (spec 5h). When
   * true the values are non-authoritative; the next successful network load
   * heals this back to false. `getDetails()` also reports reason "STALE".
   */
  get stale(): boolean {
    return this._stale;
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
  private async load(
    onAuthRejected?: (rejection: AuthRejection) => void,
    onNetworkResult?: () => void,
    onAllFailed?: (legErrors: string) => void,
    onLegFailed?: (timedOut: boolean) => void
  ): Promise<void> {
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
        this.markReady();
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

    // Hedged load (5e): the primary fires first, the secondary only if the
    // primary is slow/errors. EVERY leg that returns drains through
    // applyLoaderResult, so the reject-older guard — not first-arrival — decides
    // what wins. A late, newer primary heals forward over a stale secondary that
    // painted first.
    return this.loader
      .loadHedged(
        (result) => {
          this.applyLoaderResult(result, sig);
          if (!result.stale) onNetworkResult?.();
        },
        onAuthRejected,
        onAllFailed,
        onLegFailed
      )
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
   *      primary or a failover to a lagging (equal-or-lower generation)
   *      secondary from regressing or flapping an established client. A context
   *      SWITCH is a different query
   *      whose generation is not comparable to the held one, so it always
   *      installs (the "fresh for this context" case — a stale secondary may
   *      seed it, bounded, exactly as the spec allows; the guard must never
   *      strand `updateContext` on the held generation).
   */
  private applyLoaderResult(result: LoaderResult, sig: string): void {
    // Install only for the context the client holds NOW. Two overlapping
    // init() calls each build their own Loader, so the superseded-load guard
    // (qfg-goi1.2.7) does not cover them: the older init's response can land
    // last, and without this check it would install the previous context's
    // values under the newer context (qfg-goi1.10.12). The newer context wins.
    // shouldLog({loggerPath}) no longer mutates `_contexts` (5cb87f5), so this
    // cannot discard init's own result.
    if (sig !== encodeContexts(this._contexts)) return;

    const contextChanged = this._loadedContextSig !== sig;
    const wasStale = this._stale;
    const wasReady = this._ready;
    if (!contextChanged && !result.stale) {
      // A live network answer for the held context (a 304, or an equal-or-older
      // generation the guard below declines) still proves the network is back,
      // so the served config is no longer stale (qfg-goi1.10.12).
      this._stale = false;
    }
    if (!result.notModified || contextChanged) {
      if (contextChanged || this.shouldInstall(result.payload)) {
        this.setConfig(result.payload);
        this._loadedContextSig = sig;
        // A served-from-cache install (result.stale) is non-authoritative until
        // the network recovers; a fresh network install clears staleness AND
        // refreshes the last-known-good cache (spec 5h). We persist only what
        // we just installed (post reject-older guard), so the cached entry
        // stays monotonic for its context — an older live response is dropped by the guard
        // before it reaches here, so "the watermark rule applies to the cache
        // too" holds without a separate check. A served-stale payload is
        // already in the cache, so it is not re-persisted.
        this._stale = result.stale === true;
        this._cacheSavedAt = result.stale ? result.savedAt : undefined;
        if (!result.stale && this.loader) {
          writeLkg(this.loader.sdkKey, sig, {
            generation: this._heldGeneration,
            payload: result.payload,
          });
        }
      }
    }
    // Any live answer for the current context (installed or confirmed) makes
    // the client ready.
    if (!result.stale && this._loadedContextSig === sig) {
      this.markReady({ leg: result.leg, version: result.payload?.meta?.version });
    }
    // A heal changes what isReady()/stale/error report. setConfig() above
    // notified BEFORE readiness and staleness were updated, so subscribers
    // (sdk-react's useSyncExternalStore) must hear about the new state again,
    // whether or not this result installed anything (a 304, or an equal
    // generation after a stale or failed start, installs nothing).
    if (wasStale !== this._stale || wasReady !== this._ready) {
      this.notifySubscribers();
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
   * Both delivery legs emit the honest true commit count (spec 5f.1, revised by
   * the 2026-06-29 A2 fix): a caught-up secondary matches the held generation
   * (equal = no-op) and a lagging one is strictly lower, so it is rejected by
   * the strict-greater check, NOT by the carve-out. Only a truly unversioned
   * (<= 0) payload takes the carve-out.
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

    validateContexts(context, this._logger);
    this._contexts = context;
    this.switchServedContext(encodeContexts(context));

    if (skipLoad) {
      // No fetch now, but the next one (a poll() or poll tick) must be for this
      // context: poll() installs under the signature of `_contexts`, so a loader
      // still holding the previous context would fetch that user's values and
      // install (and persist) them as this one's (qfg-goi1.2.48). A load already
      // in flight for the previous context is dropped when it lands, since
      // applyLoaderResult installs only for the current context.
      this.loader.contexts = context;
      return;
    }

    return this.load();
  }

  /**
   * qfg-xiub: on a switch to another context, stop serving the previous
   * context's values at once, before (and regardless of) the refetch: serve
   * the new context's last-known-good copy (stale) when there is one, or
   * nothing (caller defaults) until its fetch lands. Mirrors sdk-swift's
   * updateContext. A no-op when `sig` is the context already served, or when
   * nothing has been installed for any context yet.
   */
  private switchServedContext(sig: string): void {
    if (this._loadedContextSig === undefined || this._loadedContextSig === sig) return;
    const cached = this.loader?.readLastKnownGood(this._contexts);
    if (cached) {
      this.applyLoaderResult(
        { notModified: false, payload: cached.payload, stale: true, savedAt: cached.savedAt },
        sig
      );
      return;
    }
    this._configs = Object.create(null);
    this._awaitingSwitchedContext = true;
    this._loadedContextSig = undefined;
    this._heldGeneration = 0;
    this._stale = false;
    this._cacheSavedAt = undefined;
    this.notifySubscribers();
  }

  /**
   * Start polling the server for config updates at the given frequency.
   */
  async poll({ frequencyInMs }: { frequencyInMs: number }): Promise<void> {
    if (!this.loader) {
      throw new Error("Quonfig not initialized. Call init() first.");
    }

    this.stopPollLoop();
    // The poll loop takes over healing from the init/background retry;
    // stopPolling() hands it back while the client is not ready.
    this.stopInitRetry();
    this._pollStatus = { status: "pending" };
    // stopPolling() bumped the generation; this poll() owns the new one.
    const generation = this._pollGeneration;

    // Fetch for the context we install under, as load() does (qfg-goi1.2.48).
    this.loader.contexts = this._contexts;
    const sig = encodeContexts(this._contexts);
    const loader = this.loader;
    // The first poll fetch is a poll cycle: it can enter or leave auth-failed.
    return this.pollCycle(frequencyInMs, (onAuthRejected, onNetworkResult) =>
      loader.loadHedged((result) => {
        // First poll fetch. Same guarded, hedged install path as load() — see
        // applyLoaderResult for the 304/context-switch and reject-older rules.
        this.applyLoaderResult(result, sig);
        if (!result.stale) onNetworkResult();
      }, onAuthRejected)
    ).finally(() => {
      // Schedule the recurring loop REGARDLESS of the first fetch's outcome
      // (qfg-8uw5). If the bootstrap fetch rejects — a startup network blip
      // with both primary and secondary briefly unreachable — `.then` never
      // runs, so scheduling here is the only thing that lets polling start and
      // self-heal on the next tick. `doPolling`'s own loop is already resilient
      // this way; the bootstrap must match it. (The legacy ReforgeHQ SDK
      // scheduled here too; the Quonfig port regressed it into the `.then`.)
      //
      // Only if this poll() is still current: a close()/stopPolling() or a
      // newer poll() while the first fetch was in flight bumped the
      // generation, and restarting here would leak a loop nothing can stop.
      if (generation === this._pollGeneration && this._pollStatus.status === "pending") {
        this.doPolling({ frequencyInMs }, generation);
      }
    });
  }

  /**
   * Run one poll cycle and apply the auth-failure rule to its outcome (plan
   * 2026-10-07-sdk-auth-failure-rule R2, R4, R5). `run` performs the hedged
   * fetch; it reports an auth rejection (every leg failed, primary
   * 401/403/404/410) and every live 200/304 it installs or confirms. The
   * returned promise settles as `run`'s does.
   */
  private pollCycle(
    frequencyInMs: number,
    run: (
      onAuthRejected: (rejection: AuthRejection) => void,
      onNetworkResult: () => void
    ) => Promise<void>
  ): Promise<void> {
    let rejection: AuthRejection | undefined;
    let accepted = false;
    const after = () => {
      if (rejection) {
        if (!this._authFailed) {
          this._authFailed = true;
          this._logger.error(
            `[quonfig] config fetch rejected: the SDK key is invalid or revoked (check the SDK key) ` +
              `status=${rejection.status} host=${rejection.host}; keeping the current config and ` +
              `polling once every ${AUTH_PROBE_MIN_MS / 1000}-${(AUTH_PROBE_MIN_MS + AUTH_PROBE_SPAN_MS) / 1000}s ` +
              `(or every ${frequencyInMs}ms if longer) until a fetch succeeds`
          );
        } else {
          this._logger.debug(
            `[quonfig] auth-failed probe rejected (status=${rejection.status} host=${rejection.host})`
          );
        }
      } else if (this._authFailed) {
        if (accepted) {
          this._authFailed = false;
          this._logger.info(
            `[quonfig] config fetch accepted; leaving auth-failed and resuming polling every ${frequencyInMs}ms`
          );
        } else {
          this._logger.debug("[quonfig] auth-failed probe failed; still auth-failed");
        }
      }
    };
    return run(
      (r) => {
        rejection = r;
      },
      () => {
        accepted = true;
      }
    ).then(after, (error) => {
      after();
      throw error;
    });
  }

  private doPolling({ frequencyInMs }: { frequencyInMs: number }, generation: number) {
    // While auth-failed the next poll waits max(T, frequencyInMs) (R3).
    const waitMs = this._authFailed ? Math.max(authProbeWaitMs(), frequencyInMs) : frequencyInMs;
    this._pollTimeoutId = setTimeout(() => {
      this.pollCycle(frequencyInMs, (onAuthRejected, onNetworkResult) =>
        this.load(onAuthRejected, onNetworkResult)
      )
        .then(() => {
          this._pollOutage = false;
        })
        .catch((error) => {
          // An auth rejection already logged its ERROR (or DEBUG) above, and a
          // failed probe while auth-failed logs at DEBUG only.
          if (this._authFailed) return;
          // A failed tick (every leg failed, no last-known-good entry) must not
          // become an unhandled rejection: Node exits on one, and browsers
          // report each to error trackers at the poll frequency. The loop keeps
          // the last good config and retries on the next tick. Warn once per
          // outage, not once per tick.
          if (!this._pollOutage) {
            this._pollOutage = true;
            const message = error instanceof Error ? error.message : String(error);
            this._logger.warn(
              `[quonfig] poll failed (${message}); keeping the current config and retrying every ${frequencyInMs}ms`
            );
          }
        })
        .finally(() => {
          if (generation === this._pollGeneration && this.pollStatus.status === "running") {
            this.doPolling({ frequencyInMs }, generation);
          }
        });
    }, waitMs);

    this._pollStatus = { status: "running", frequencyInMs };
  }

  /**
   * Stop polling for config updates. Does not stop the init/background retry:
   * a client that is not ready yet (including a pending `init()` under
   * `onInitFailure: "wait"`) keeps retrying until config arrives. `close()`
   * stops everything.
   */
  stopPolling(): void {
    this.stopPollLoop();
    // Never leave a not-ready client (or a pending init()) without a retry
    // loop: resume the init/background retry that poll() paused.
    if (!this._ready) this._resumeInitRetry?.();
  }

  private stopPollLoop(): void {
    this._pollGeneration += 1;
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
   * After a failed POST it respects the 30s resend floor and Retry-After.
   * Never rejects.
   */
  async flush(): Promise<void> {
    await this.telemetryReporter?.flush();
  }

  /**
   * Tear down the SDK: stop polling and the telemetry timer, then send the
   * current telemetry window once (2s deadline, keepalive). Kept batches from
   * an earlier failure are not resent. Never rejects and leaves no timer armed.
   */
  async close(): Promise<void> {
    // Stops both loops: polling and the init/background retry.
    this._resumeInitRetry = undefined;
    this.stopPollLoop();
    this.stopInitRetry();
    const reporter = this.telemetryReporter;
    this.removePageHideListener();
    // Hydrated reads whose network Config never arrived are dropped (qfg-27wr).
    this._heldHydratedReads.clear();
    await reporter?.close();
  }

  /**
   * Stop the telemetry timer and abort any in-flight POST without a final
   * flush. Prefer `close()` or `flush()` for normal teardown.
   */
  stopTelemetry(): void {
    this.telemetryReporter?.stop();
    this.removePageHideListener();
  }

  private teardownTelemetry(): void {
    this.telemetryReporter?.stop();
    this.telemetryReporter = undefined;
    this.removePageHideListener();
  }

  private removePageHideListener(): void {
    if (this.pageHideListener && typeof window !== "undefined") {
      window.removeEventListener?.("pagehide", this.pageHideListener);
    }
    this.pageHideListener = undefined;
  }

  /** P7 telemetry logger over the SDK logger; debug is gated by {@link TELEMETRY_LOG_LEVEL_KEY}. */
  private telemetryLogger(): TelemetryLogger {
    const prefix = (message: string) => `[quonfig] ${message}`;
    return {
      debug: (message) => {
        let enabled = false;
        try {
          enabled = this.shouldLog({
            configKey: TELEMETRY_LOG_LEVEL_KEY,
            desiredLevel: "debug",
            defaultLevel: "error",
          });
        } catch {
          // Logging must never break telemetry.
        }
        if (enabled) this._logger.debug(prefix(message));
      },
      info: (message) => this._logger.info(prefix(message)),
      warn: (message) => this._logger.warn(prefix(message)),
      error: (message) => this._logger.error(prefix(message)),
    };
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
    this._configs = Config.digest(rawValues, this._customLogger ? this._logger : undefined);
    this._awaitingSwitchedContext = false;
    this._heldGeneration = rawValues?.meta?.generation ?? 0;
    this._configInstalls += 1;
    this.loaded = true;
    this.resolveHeldHydratedReads();
    this.notifySubscribers();
  }

  /**
   * Seed the client with pre-evaluated flags (e.g. for SSR hydration).
   * Flags are flat key-value pairs: { flagKey: value }.
   */
  hydrate(flags: Record<string, unknown>): void {
    const configs: { [key: string]: Config } = Object.assign(Object.create(null), this._configs);
    Object.keys(flags).forEach((key) => {
      const value = flags[key] as ConfigValue;
      const config = new Config(key, value, hydratedType(value));
      this._hydratedConfigs.add(config);
      configs[key] = config;
    });
    this._configs = configs;
    this._awaitingSwitchedContext = false;
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
   * Check if a feature flag is enabled: true only for a resolved boolean
   * `true`. Never throws. Returns false, and logs once per key, for a missing
   * key, a non-boolean value (no string coercion: a stored "true" is a
   * string) or a value that could not be read (qfg-zvyy).
   */
  isEnabled(key: string): boolean {
    try {
      const value = this.get(key);
      if (!this.loaded || key.startsWith(LOG_LEVEL_KEY_PREFIX)) return value === true;
      const config = this._configs[key];
      if (!config) {
        // No config for the current context yet (a context switch is still
        // fetching): that is "using the default", not a missing flag.
        if (!this._awaitingSwitchedContext) {
          this.warnReadFailure(key, `no config found for key "${key}"`);
        }
        return false;
      }
      if (config.coercionError) {
        this.warnReadFailure(key, config.coercionError);
        return false;
      }
      if (config.type !== "bool" || typeof config.value !== "boolean") {
        this.warnReadFailure(key, `config "${key}" has type ${config.type}, expected bool`);
        return false;
      }
      return config.value;
    } catch {
      return false;
    }
  }

  /**
   * Count one evaluation of `key` (its Config is undefined for a missing key)
   * and, when `fireCallback`, schedule afterEvaluationCallback. Before init()
   * has wired telemetry, a read of a Config is buffered and replayed by
   * flushPreInitReads() with the callback init() installs.
   */
  private recordEvaluation(key: string, config: Config | undefined, fireCallback = true): void {
    if (config && !this._telemetryWired) {
      if (fireCallback) {
        const seen = this._preInitReads.get(config);
        if (seen !== undefined) this._preInitReads.set(config, seen + 1);
        else if (this._preInitReads.size < PRE_INIT_READS_MAX) this._preInitReads.set(config, 1);
      }
      return;
    }
    if (config) this.recordToAggregator(config, 1);
    if (fireCallback) {
      const value = config?.value;
      // afterEvaluationCallback is user-supplied — keep it deferred so a
      // throwing or slow callback can't block the calling get().
      setTimeout(() => this.afterEvaluationCallback(key, value, this._contexts));
    }
  }

  /** Record `count` reads of `config`, holding hydrated (metadata-less) ones. */
  private recordToAggregator(config: Config, count: number): void {
    if (!this._collectEvaluationSummaries || !this.evaluationSummaryAggregator) return;
    if (this._hydratedConfigs.has(config)) {
      const sig = valueSignature(config.value);
      const held = this._heldHydratedReads.get(config.key);
      if (held && held.sig === sig) {
        held.count += count;
      } else {
        // A re-hydrate with a new value supersedes reads of the old one.
        this._heldHydratedReads.set(config.key, { sig, count });
      }
      return;
    }
    this.evaluationSummaryAggregator.record(config, count);
  }

  /**
   * Replay reads made before init(): record them and fire the
   * afterEvaluationCallback init() installed, once per read.
   */
  private flushPreInitReads(): void {
    if (this._preInitReads.size === 0) return;
    const reads = this._preInitReads;
    this._preInitReads = new Map();
    reads.forEach((count, config) => {
      this.recordToAggregator(config, count);
    });
    this.resolveHeldHydratedReads();
    setTimeout(() => {
      reads.forEach((count, config) => {
        for (let i = 0; i < count; i++) {
          this.afterEvaluationCallback(config.key, config.value, this._contexts);
        }
      });
    });
  }

  /**
   * After a network install, settle held hydrated reads: a key whose new
   * Config has the same value is recorded with that Config's metadata; a
   * different value, or a key the install does not carry, drops them. Keys
   * still served by their hydrated Config stay held.
   */
  private resolveHeldHydratedReads(): void {
    if (this._heldHydratedReads.size === 0) return;
    this._heldHydratedReads.forEach((held, key) => {
      const config = this._configs[key];
      if (config && this._hydratedConfigs.has(config)) return;
      this._heldHydratedReads.delete(key);
      if (
        config?.configEvaluationMetadata &&
        valueSignature(config.value) === held.sig &&
        this._collectEvaluationSummaries
      ) {
        this.evaluationSummaryAggregator?.record(config, held.count);
      }
    });
  }

  /**
   * Read the evaluated value for a config key without counting it as an
   * evaluation: no evaluation summary is recorded, `afterEvaluationCallback`
   * does not fire, and nothing is logged before the client has loaded (the
   * result is then `undefined`). For framework bindings that read a snapshot
   * more often than the application consumes the value, such as React's
   * `useSyncExternalStore`. Application code should use `get()`.
   */
  peek(key: string): ConfigValue {
    if (!this.loaded) {
      return undefined;
    }
    return this.configs[key]?.value;
  }

  /**
   * Get the evaluated value for a config key.
   */
  get(key: string): ConfigValue {
    if (!this.loaded) {
      if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
        this._logger.warn(
          `Quonfig warning: The client has not finished loading data yet. Unable to look up actual value for key "${key}".`
        );
      }
      return undefined;
    }

    const config = this.configs[key];
    const value = config?.value;

    if (config?.coercionError && !key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      this.warnReadFailure(key, config.coercionError);
    }

    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      // qfg-5jcd: record synchronously. record() is a Map.set + counter
      // increment with no I/O; deferring it via setTimeout(0) caused a tight
      // sync get()-loop followed by await close() to race past the records
      // and ship empty telemetry. Matches sdk-node/src/quonfig.ts.
      this.recordEvaluation(key, config);
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

    if (config.coercionError) {
      if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
        this.recordEvaluation(key, config, false);
      }
      return {
        value: undefined,
        reason: "ERROR",
        errorCode: "TYPE_MISMATCH",
        errorMessage: config.coercionError,
        variant: "default",
        flagMetadata: buildFlagMetadata(
          config.configEvaluationMetadata?.configId,
          config.configEvaluationMetadata?.configType,
          undefined,
          undefined,
          "ERROR"
        ),
      };
    }

    const md = config.configEvaluationMetadata;
    // Older api-delivery deployments don't emit `reason` on the wire; treat
    // their absence as STATIC so consumers see a sensible variant string.
    const underlyingReason: EvaluationReason = md?.reason ?? "STATIC";
    const ruleIndex = md?.ruleIndex;
    const weightedValueIndex = md?.weightedValueIndex;

    // When serving from the stale last-known-good cache (spec 5h), report the
    // OpenFeature-standard STALE reason so consumers know the value is
    // non-authoritative — but keep `variant` and `flagMetadata` derived from
    // the UNDERLYING targeting reason, so cached values still expose which
    // rule/split produced them.
    const reason: EvaluationReason = this._stale ? "STALE" : underlyingReason;

    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      this.recordEvaluation(key, config);
    }

    return {
      value: config.value as unknown as T,
      reason,
      variant: buildVariant(underlyingReason, ruleIndex, weightedValueIndex),
      flagMetadata: buildFlagMetadata(
        md?.configId,
        md?.configType,
        ruleIndex,
        weightedValueIndex,
        underlyingReason
      ),
    };
  }

  /**
   * Get a duration config. Returns `defaultValue` (undefined when omitted)
   * for a missing key, and for a value that is not a duration: another type
   * (a stored string "PT1S" is a string, not a duration) or a value outside
   * the duration grammar. Never throws; a failed read logs once per key
   * (qfg-zvyy).
   */
  getDuration(key: string, defaultValue?: Duration): Duration | undefined {
    const value = this.get(key);
    if (!this.loaded) return defaultValue;

    const config = this._configs[key];
    if (!config) return defaultValue;

    if (config.coercionError) {
      this.warnReadFailure(key, config.coercionError);
      return defaultValue;
    }

    if (config.type !== "duration" || !isDuration(value)) {
      this.warnReadFailure(key, `config "${key}" has type ${config.type}, expected duration`);
      return defaultValue;
    }

    return value;
  }

  private warnedReadFailureKeys = new Set<string>();

  /**
   * One warning per key per client for a read that returned no value (a
   * wrong type or a malformed value), so a broken config is not mistaken
   * for "using the default". Never includes the raw value.
   */
  private warnReadFailure(key: string, reason: string): void {
    if (this.warnedReadFailureKeys.has(key)) return;
    this.warnedReadFailureKeys.add(key);
    this._logger.warn(
      `Quonfig warning: read of "${key}" returned no value; the caller's default applies: ${reason}`
    );
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
   *    `init()`. The SDK uses `loggerKey` as the underlying config key.
   *    `loggerPath` does not change the client's context or what is fetched:
   *    the browser SDK evaluates server-side once per fetched context, so every
   *    `loggerPath` gets the same answer from a given config.
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
      // The logger path is deliberately NOT added to the live context (as
      // `quonfig-sdk-logging`). Doing so changed every later fetch's context:
      // the next load counted as a context switch, which skips the
      // reject-older guard, so an older generation could replace a newer one,
      // and it changed the inputs to every flag. The browser evaluates
      // server-side once per fetched context, so the path could not select
      // per-logger rules anyway.
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
