/** Why `init()` failed under `onInitFailure: "fail"`. */
export type QuonfigInitErrorReason = "timeout" | "unavailable" | "unauthorized";

/**
 * The rejection of `init()` under `onInitFailure: "fail"` (the default) when no
 * Quonfig config is available: no live answer and no cached last-known-good
 * copy for the context (project/plans/2026-10-05-init-failure-design.md B.4).
 *
 * - `timeout`: no fetch attempt finished before `initTimeout` (the network hangs).
 * - `unavailable`: every attempt until `initTimeout` failed (refused, DNS, 5xx).
 * - `unauthorized`: the primary rejected the SDK key (401/403/404/410) and every
 *   leg failed. Raised at once, without waiting out `initTimeout`.
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
