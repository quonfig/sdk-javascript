import { headers, TELEMETRY_TIMEOUT, getDefaultTelemetryUrl } from "../apiHelpers";

export type TelemetryUploaderParams = {
  sdkKey: string;
  telemetryUrl?: string;
  /**
   * Active domain used to derive the default telemetryUrl when omitted.
   * See `InitOptions.domain` for resolution order.
   */
  domain?: string;
  /** Per-POST deadline (ms) for {@link TelemetryUploader.post}. Defaults to 10s. */
  timeout?: number;
  clientVersion: string;
};

/** What the transport needs from a telemetry response. */
export interface TelemetryHttpResult {
  status: number;
  /** The Retry-After header, when the response carried one the page can read. */
  retryAfter?: string;
  /** First 1024 chars of the body, read only for a rejected (non-retryable 4xx) status. */
  bodySnippet: string;
}

/** A telemetry POST that got no HTTP response. */
export class TelemetryRequestError extends Error {
  readonly reason: "timeout" | "aborted" | "network";
  readonly cause: unknown;

  constructor(reason: "timeout" | "aborted" | "network", cause?: unknown) {
    super(`telemetry request ${reason}`);
    this.name = "TelemetryRequestError";
    this.reason = reason;
    this.cause = cause;
    // Keep instanceof working when compiled to ES5-style classes.
    Object.setPrototypeOf(this, TelemetryRequestError.prototype);
  }
}

export default class TelemetryUploader {
  sdkKey: string;
  telemetryUrl: string;
  timeout: number;
  clientVersion: string;

  constructor({ sdkKey, telemetryUrl, domain, timeout, clientVersion }: TelemetryUploaderParams) {
    this.sdkKey = sdkKey;
    this.telemetryUrl = telemetryUrl || getDefaultTelemetryUrl({ domain });
    this.timeout = timeout || TELEMETRY_TIMEOUT;
    this.clientVersion = clientVersion;
  }

  /**
   * @deprecated No-op. Every request owns its own deadline timer now, so there
   * is no shared timer to clear.
   */
  clearAbortTimeout(): void {}

  postUrl(): string {
    return `${this.telemetryUrl}/api/v1/telemetry/`;
  }

  /**
   * POST one serialized batch. Each call owns its AbortController and its
   * deadline timer (set before fetch, cleared in `finally`), so concurrent
   * calls never share or clear each other's timer and no timer outlives the
   * request. Resolves with the HTTP status for every response; rejects with a
   * {@link TelemetryRequestError} (timeout, aborted, network) when there is
   * none. The deadline is a timer + AbortController rather than
   * `AbortSignal.timeout` so it runs on the page's (or a test's) timers.
   */
  async send(
    body: string,
    opts: { timeoutMs: number; signal?: AbortSignal; keepalive?: boolean }
  ): Promise<TelemetryHttpResult> {
    const controller = new AbortController();
    let reason: "timeout" | "aborted" | undefined;
    const timer = setTimeout(() => {
      reason = "timeout";
      controller.abort();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      reason ??= "aborted";
      controller.abort();
    };
    const { signal } = opts;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }

    try {
      const response = await fetch(this.postUrl(), {
        method: "POST",
        headers: {
          ...headers(this.sdkKey, this.clientVersion),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
        // keepalive lets the pagehide / close() flush outlive the page. Regular
        // ticks do not use it: keepalive bodies share a 64KB browser quota.
        keepalive: opts.keepalive === true,
      });
      const status = response.status;
      const retryAfter = response.headers.get("Retry-After") ?? undefined;
      let bodySnippet = "";
      if (status >= 300 && status < 500 && ![401, 403, 404, 408, 429].includes(status)) {
        try {
          bodySnippet = (await response.text()).slice(0, 1024);
        } catch {
          // The status is what matters; the snippet is best effort.
        }
      }
      return { status, retryAfter, bodySnippet };
    } catch (err) {
      throw new TelemetryRequestError(reason ?? "network", err);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Post telemetry data to the telemetry endpoint (one-off, outside the
   * reporter's retained queue). Resolves with the response JSON on 2xx or the
   * status code otherwise; rejects on a timeout or network error.
   *
   * @deprecated The SDK sends telemetry through its reporter; kept for callers
   * of the `telemetryUploader` accessor.
   */
  async post(data: any): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(this.postUrl(), {
        method: "POST",
        headers: {
          ...headers(this.sdkKey, this.clientVersion),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      console.warn(
        `Quonfig warning: Error uploading telemetry ${response.status} ${response.statusText}`
      );
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  }
}
