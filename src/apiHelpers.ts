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
export const DEFAULT_API_URLS = ["https://primary.quonfig.com"];
