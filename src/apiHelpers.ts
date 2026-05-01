import { base64Encode } from "./context";

/**
 * Build the Authorization header for quonfig API requests.
 * Format: Basic base64("1:{sdkKey}")
 */
export const authHeader = (sdkKey: string): string =>
  `Basic ${base64Encode(`1:${sdkKey}`)}`;

/**
 * Build the standard headers for quonfig API requests.
 * Note: We intentionally omit X-Quonfig-Client-Version to avoid
 * CORS preflight issues in browsers. Custom headers trigger OPTIONS
 * preflight which requires server-side CORS configuration.
 */
export const headers = (sdkKey: string, _clientVersion: string) => ({
  Authorization: authHeader(sdkKey),
});

export const DEFAULT_TIMEOUT = 10000;

/**
 * Default Quonfig domain. Used when no explicit URL options are supplied
 * and `QUONFIG_DOMAIN` is not set in `process.env`.
 */
export const DEFAULT_DOMAIN = "quonfig.com";

/**
 * Resolve the active Quonfig domain.
 *
 * Order:
 *   1. `process.env.QUONFIG_DOMAIN` (Node side / build-time inlined by some bundlers)
 *   2. Hardcoded default `"quonfig.com"`
 *
 * This is guarded with `typeof process !== "undefined"` so a pure browser
 * runtime (where `process` does not exist) does not throw.
 *
 * Note: in a real browser, `process.env` is typically not available at
 * runtime — bundlers may inline `process.env.QUONFIG_DOMAIN` at build time
 * but at runtime this function falls through to the hardcoded default.
 * The intended override path for the browser is the explicit `apiUrls` /
 * `telemetryUrl` init options.
 */
export const getDomain = (): string => {
  try {
    if (
      typeof process !== "undefined" &&
      process &&
      process.env &&
      typeof process.env.QUONFIG_DOMAIN === "string" &&
      process.env.QUONFIG_DOMAIN.length > 0
    ) {
      return process.env.QUONFIG_DOMAIN;
    }
  } catch {
    // No-op: any access error means we're in a runtime without a usable
    // `process` (some bundler configurations stub it as a getter that
    // throws). Fall through to the hardcoded default.
  }
  return DEFAULT_DOMAIN;
};

/**
 * Default ordered list of API base URLs to try, derived from `QUONFIG_DOMAIN`.
 * Frontend SDK does NOT open SSE — only the eval-with-context HTTP endpoint
 * is hit, so we ship both primary and secondary as failover targets.
 */
export const getDefaultApiUrls = (): string[] => {
  const domain = getDomain();
  return [`https://primary.${domain}`, `https://secondary.${domain}`];
};

/**
 * Default telemetry base URL, derived from `QUONFIG_DOMAIN`.
 */
export const getDefaultTelemetryUrl = (): string => {
  return `https://telemetry.${getDomain()}`;
};
