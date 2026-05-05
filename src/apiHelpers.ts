import { base64Encode } from "./context";

/**
 * Build the Authorization header for quonfig API requests.
 * Format: Basic base64("1:{sdkKey}")
 */
export const authHeader = (sdkKey: string): string => `Basic ${base64Encode(`1:${sdkKey}`)}`;

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

export type DomainOptions = { domain?: string };

/**
 * Resolve the active Quonfig domain.
 *
 * Order (highest wins):
 *   1. `options.domain` — the documented browser path (single knob that
 *      flips api + telemetry URLs in lockstep, set via `init({ domain })`
 *      or @quonfig/react `<QuonfigProvider domain=...>`)
 *   2. `process.env.QUONFIG_DOMAIN` — useful Node-side / SSR / build-time
 *      inlining; not reliably present at runtime in browsers
 *   3. Hardcoded default `"quonfig.com"`
 *
 * The env-var read is guarded so a pure browser runtime (where `process`
 * does not exist or is stubbed) does not throw.
 */
export const getDomain = (options?: DomainOptions): string => {
  if (options && typeof options.domain === "string" && options.domain.length > 0) {
    return options.domain;
  }
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
 * Default ordered list of API base URLs, derived from the active domain.
 * Frontend SDK does NOT open SSE — only the eval-with-context HTTP endpoint
 * is hit, so we ship both primary and secondary as failover targets.
 */
export const getDefaultApiUrls = (options?: DomainOptions): string[] => {
  const domain = getDomain(options);
  return [`https://primary.${domain}`, `https://secondary.${domain}`];
};

/**
 * Default telemetry base URL, derived from the active domain.
 */
export const getDefaultTelemetryUrl = (options?: DomainOptions): string => {
  return `https://telemetry.${getDomain(options)}`;
};
