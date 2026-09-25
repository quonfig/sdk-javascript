import type { EvaluationSummaryAggregator } from "./evaluationSummaryAggregator";
import type TelemetryUploader from "./uploader";
import {
  SHUTDOWN_FLUSH_DEADLINE_MS,
  TELEMETRY_DEFAULTS,
  TelemetryTransportQueue,
  type TelemetryLogger,
} from "./transportQueue";

/** Resolved transport settings (see the `telemetry*` options on InitOptions). */
export interface TelemetryReporterConfig {
  flushIntervalMs: number;
  timeoutMs: number;
  maxRetainedBatches: number;
  maxRetainedBytes: number;
  maxRetainedAgeMs: number;
  maxEvaluationSummaries: number;
}

/** A positive finite number, else the default. */
export function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the `telemetry*` init options against the browser defaults. Invalid
 * values (non-finite, <= 0) fall back to the default.
 */
export function resolveTelemetryConfig(opts: {
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxRetainedBatches?: number;
  maxRetainedBytes?: number;
  maxRetainedAgeMs?: number;
  maxEvaluationSummaries?: number;
}): TelemetryReporterConfig {
  return {
    flushIntervalMs: positiveOr(opts.flushIntervalMs, TELEMETRY_DEFAULTS.flushIntervalMs),
    timeoutMs: positiveOr(opts.timeoutMs, TELEMETRY_DEFAULTS.timeoutMs),
    maxRetainedBatches: positiveOr(opts.maxRetainedBatches, TELEMETRY_DEFAULTS.maxRetainedBatches),
    maxRetainedBytes: positiveOr(opts.maxRetainedBytes, TELEMETRY_DEFAULTS.maxRetainedBytes),
    maxRetainedAgeMs: positiveOr(opts.maxRetainedAgeMs, TELEMETRY_DEFAULTS.maxRetainedAgeMs),
    maxEvaluationSummaries: positiveOr(
      opts.maxEvaluationSummaries,
      TELEMETRY_DEFAULTS.maxEvaluationSummaries
    ),
  };
}

/**
 * TelemetryReporter drains the evaluation-summary aggregator once per tick
 * and hands the serialized window to a {@link TelemetryTransportQueue}, which
 * retains failed batches byte-for-byte (in memory, for the life of the page)
 * and resends them under the transport policy (qfg-y8je.11: 30s ticks, one
 * POST in flight, 30s floor after a failure, Retry-After, 5 batches / 512KB /
 * 5 min retention, disable on 401/403/404, keepalive final flush on pagehide).
 * Mirrors sdk-node's src/telemetry/reporter.ts.
 */
export class TelemetryReporter {
  readonly config: TelemetryReporterConfig;

  private aggregator: EvaluationSummaryAggregator;
  private logger: TelemetryLogger;
  private queue: TelemetryTransportQueue;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private pendingTick: Promise<void> | undefined;

  constructor(args: {
    uploader: TelemetryUploader;
    aggregator: EvaluationSummaryAggregator;
    logger: TelemetryLogger;
    config: TelemetryReporterConfig;
  }) {
    this.aggregator = args.aggregator;
    this.logger = args.logger;
    this.config = args.config;
    const { uploader } = args;
    this.queue = new TelemetryTransportQueue({
      send: (body, timeoutMs, signal, keepalive) =>
        uploader.send(body, { timeoutMs, signal, keepalive }),
      telemetryUrl: uploader.telemetryUrl,
      logger: this.logger,
      timeoutMs: this.config.timeoutMs,
      maxRetainedBatches: this.config.maxRetainedBatches,
      maxRetainedBytes: this.config.maxRetainedBytes,
      maxRetainedAgeMs: this.config.maxRetainedAgeMs,
      onDisabled: () => this.onDisabled(),
    });
  }

  /**
   * Start the tick timer. Fixed cadence: tick k fires at k * flushIntervalMs
   * regardless of how long a drain takes.
   */
  start(): void {
    if (this.closed || this.queue.disabled || this.timer !== undefined) return;
    this.schedule();
  }

  private schedule(): void {
    const t = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.queue.disabled) return;
      this.schedule();
      this.tick().catch((err) => this.logger.debug(`Telemetry tick failed: ${err}`));
    }, this.config.flushIntervalMs);
    // Outside a browser (SSR, tests) telemetry must never keep the process alive.
    const maybeUnref = t as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
    this.timer = t;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One tick of the contract's model: skip if closed, disabled or a POST is in
   * flight (P2; the live window keeps aggregating); expire aged batches; skip
   * if the 30s floor or Retry-After has not elapsed; serialize the live window
   * once and append it; drain oldest-first. Never rejects.
   */
  tick(): Promise<void> {
    if (this.closed || this.queue.disabled || this.queue.busy || this.pendingTick) {
      return Promise.resolve();
    }
    const run = this.runTick();
    this.pendingTick = run;
    const clear = (): void => {
      if (this.pendingTick === run) this.pendingTick = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  private async runTick(): Promise<void> {
    this.queue.expire();
    if (!this.queue.sendAllowed()) return;
    const body = this.aggregator.drain();
    if (body !== undefined) this.queue.append(body);
    await this.queue.drain();
  }

  /** Resolves when no tick (and so no POST) is running. */
  async whenIdle(): Promise<void> {
    while (this.pendingTick) {
      await this.pendingTick.catch(() => undefined);
    }
    await this.queue.whenIdle();
  }

  /**
   * Send the live window now (public `Quonfig.flush()`). Waits for an
   * in-flight POST first (bounded by the request timeout), then runs a tick,
   * so after a failure it respects the 30s floor and Retry-After. Never throws.
   */
  async flush(): Promise<void> {
    if (this.closed || this.queue.disabled) return;
    try {
      await this.whenIdle();
      await this.tick();
    } catch (err) {
      this.logger.debug(`Telemetry flush failed: ${err}`);
    }
  }

  /**
   * pagehide (P8, browser): send the live window once with `keepalive` and a
   * 2s deadline. Returns synchronously: the POST is fire-and-forget, so the
   * handler never blocks unload. The retained queue is not drained (a page
   * being unloaded is no time to resend an outage backlog); if the page comes
   * back from the back/forward cache, ticking simply continues.
   */
  onPageHide(): void {
    if (this.closed || this.queue.disabled) return;
    const body = this.aggregator.drain();
    if (body === undefined) return;
    void this.queue.sendFinal(body, Math.min(SHUTDOWN_FLUSH_DEADLINE_MS, this.config.timeoutMs));
  }

  /**
   * Shutdown (public `Quonfig.close()`): stop the timer, abort any in-flight
   * POST, then give the live window one keepalive POST with a 2s deadline. The
   * retained queue is not drained. Idempotent; never throws; leaves no timer
   * armed once it resolves.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.clearTimer();
    this.queue.abortInFlight();
    this.closing = (async () => {
      if (this.queue.disabled) return;
      const body = this.aggregator.drain();
      if (body === undefined) return;
      await this.queue.sendFinal(body, Math.min(SHUTDOWN_FLUSH_DEADLINE_MS, this.config.timeoutMs));
    })();
    return this.closing;
  }

  /** Stop the timer and abort any in-flight POST without a final flush. */
  stop(): void {
    this.closed = true;
    this.clearTimer();
    this.queue.abortInFlight();
  }

  /** Test-visible state (the contract's retained_count / retained_bytes / telemetry_enabled). */
  debugState(): {
    retainedCount: number;
    retainedBytes: number;
    enabled: boolean;
    inFlight: boolean;
    timerActive: boolean;
  } {
    return {
      retainedCount: this.queue.retainedCount,
      retainedBytes: this.queue.retainedBytes,
      enabled: !this.queue.disabled,
      inFlight: this.queue.busy,
      timerActive: this.timer !== undefined,
    };
  }

  private onDisabled(): void {
    this.clearTimer();
    this.aggregator.disable();
  }
}
