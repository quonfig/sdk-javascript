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

/**
 * Per-leg hard fetch deadline (ms). Lowered from 10s to 3s with the parallel
 * hedge (spec 5e): a page loaded against a hung primary used to wait the full
 * 10s before even trying the secondary. 3s sits above a cold-start / mobile
 * primary (so a slow-but-alive primary isn't clipped) but far below the old
 * wall. It must stay ABOVE DEFAULT_HEDGE_DELAY so a hedged secondary leg gets
 * its own budget. Mirrors sdk-go's DefaultConfigFetchTimeout (3s).
 */
export const DEFAULT_TIMEOUT = 3000;

/**
 * How long the hedge waits for the primary leg before ALSO firing the
 * secondary in parallel (ms). Fire-on-slow, never on a fast primary success,
 * so the secondary is contacted only for the bounded slice of requests slower
 * than this delay (spec 5e). Mirrors sdk-go's DefaultConfigFetchHedgeDelay (2s).
 *
 * Raising this toward the primary's measured p99 reduces how often the
 * secondary is touched; the reject-older guard (spec 5f) makes firing it early
 * harmless either way — the depth-1 secondary's generation=1 is rejected for an
 * established client, so an early hedge can never regress or flap it.
 */
export const DEFAULT_HEDGE_DELAY = 2000;

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
