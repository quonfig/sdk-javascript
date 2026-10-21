/** Why `init()` failed under `onInitFailure: "fail"`. */
export type QuonfigInitErrorReason = "timeout" | "unavailable" | "unauthorized";

/**
 * The rejection of `init()` under `onInitFailure: "fail"` (the default) when no
 * Quonfig config is available: no live answer and no cached last-known-good
 * copy for the context (project/plans/2026-10-05-init-failure-design.md B.4).
 *
 * - `timeout`: the last attempt hung (every leg in it timed out, or was still
 *   pending at `initTimeout`), or no attempt completed.
 * - `unavailable`: the last attempt failed fast on some leg (refused, DNS, 5xx).
 * - `unauthorized`: every configured leg rejected the SDK key (401/403/404/410).
 *   Raised at once, without waiting out `initTimeout`.
 *
 * The message (and `cause`) name legs by host and `HTTP <status>` only: never
 * the SDK key, URL credentials or a response body.
 *
 * The client keeps retrying in the background after this rejection and heals
 * when the network returns (`isReady()` turns true, subscribers are notified).
 */
export class QuonfigInitError extends Error {
  readonly reason: QuonfigInitErrorReason;
  readonly cause: unknown;

  constructor(reason: QuonfigInitErrorReason, message: string, cause?: unknown) {
    super(message);
    this.name = "QuonfigInitError";
    this.reason = reason;
    this.cause = cause;
    // Keep instanceof working when compiled to ES5-style classes.
    Object.setPrototypeOf(this, QuonfigInitError.prototype);
  }
}
