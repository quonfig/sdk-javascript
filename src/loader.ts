import { headers, DEFAULT_TIMEOUT, getDefaultApiUrls } from "./apiHelpers";
import { encodeContexts } from "./context";
import type { Contexts, EvaluationPayload, CollectContextMode } from "./types";

export type LoaderParams = {
  sdkKey: string;
  contexts: Contexts;
  /** Ordered list of API base URLs to try for failover. */
  apiUrls?: string[];
  /**
   * Active domain used to derive default apiUrls when `apiUrls` is omitted.
   * See `InitOptions.domain` for resolution order.
   */
  domain?: string;
  timeout?: number;
  collectContextMode?: CollectContextMode;
  clientVersion?: string;
};

/**
 * Result of a {@link Loader.load}:
 * - `notModified: false` — the server returned a fresh 200; `payload` holds the
 *   new evaluations and the caller should replace its cache.
 * - `notModified: true` — the server returned 304 Not Modified; the caller MUST
 *   keep its currently-cached evaluations untouched (no `payload` is carried).
 *
 * A `notModified: true` can only follow a prior successful 200 for the same
 * request URL, because the loader never sends `If-None-Match` without a stored
 * ETag — so a 304 always implies the caller already holds the matching cache.
 */
export type LoaderResult =
  | { notModified: false; payload: EvaluationPayload }
  | { notModified: true };

export default class Loader {
  sdkKey: string;
  contexts: Contexts;
  apiUrls: string[];
  timeout: number;
  collectContextMode: CollectContextMode;
  clientVersion: string;
  abortTimeoutId: ReturnType<typeof setTimeout> | undefined;
  abortController: AbortController | undefined;

  /**
   * ETags from prior 200 responses, keyed by the FULL request URL (which embeds
   * the encoded context). Keying per-URL — rather than a single shared field
   * like sdk-node — is the safety invariant: an ETag is only ever sent back to
   * the exact URL that minted it, so a context switch (a different URL) can
   * never replay a stale ETag and get a wrong 304. The server's ETag also folds
   * in both the workspace version and the context token, so a stale entry can
   * at worst yield a fresh 200, never stale data.
   *
   * Bounded as an LRU so it can't grow without limit as contexts change, while
   * still letting a small set of alternating contexts (e.g. a segment MATCH/MISS
   * probe, or multi-tenant switching) each keep their 304 fast-path.
   */
  private etags: Map<string, string> = new Map();
  private static readonly ETAG_CACHE_LIMIT = 16;

  constructor({
    sdkKey,
    contexts,
    apiUrls,
    domain,
    timeout,
    collectContextMode = "PERIODIC_EXAMPLE",
    clientVersion = "",
  }: LoaderParams) {
    this.sdkKey = sdkKey;
    this.contexts = contexts;
    this.apiUrls = (apiUrls ?? getDefaultApiUrls({ domain })).map((u) => u.replace(/\/$/, ""));
    if (this.apiUrls.length === 0) {
      throw new Error("apiUrls must not be empty");
    }
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.collectContextMode = collectContextMode;
    this.clientVersion = clientVersion;
  }

  url(apiUrl: string): string {
    const encodedContext = encodeContexts(this.contexts);
    return `${apiUrl}/api/v2/configs/eval-with-context/${encodedContext}?collectContextMode=${this.collectContextMode}`;
  }

  load(): Promise<LoaderResult> {
    this.abortController?.abort();

    return this.loadWithFailover();
  }

  /**
   * Store the ETag for a URL, evicting the least-recently-stored entry once the
   * LRU cap is exceeded. Re-storing a key moves it to the most-recent end.
   */
  private rememberEtag(url: string, etag: string): void {
    this.etags.delete(url);
    this.etags.set(url, etag);
    while (this.etags.size > Loader.ETAG_CACHE_LIMIT) {
      const oldest = this.etags.keys().next().value;
      if (oldest === undefined) break;
      this.etags.delete(oldest);
    }
  }

  /**
   * Try each API URL in order. Return the first successful result.
   */
  private async loadWithFailover(): Promise<LoaderResult> {
    let lastError: any;

    for (const apiUrl of this.apiUrls) {
      try {
        return await this.fetchFromUrl(apiUrl);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("All API URLs failed");
  }

  private fetchFromUrl(apiUrl: string): Promise<LoaderResult> {
    return new Promise<LoaderResult>((resolve, reject) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      const url = this.url(apiUrl);

      // Conditional request: if we have an ETag from a prior 200 for THIS exact
      // URL, ask the server to revalidate. A 304 means both the workspace
      // version and the context are unchanged (the server's ETag folds in
      // both), so our cache is still correct.
      const requestHeaders: Record<string, string> = headers(this.sdkKey, this.clientVersion);
      const storedEtag = this.etags.get(url);
      if (storedEtag) {
        requestHeaders["If-None-Match"] = storedEtag;
      }

      fetch(url, { signal, headers: requestHeaders })
        .then((response) => {
          this.clearAbortTimeout();

          if (response.status === 304) {
            // Not modified — keep the cached evaluations. No body to parse.
            resolve({ notModified: true });
            return undefined;
          }

          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }

          // Capture the ETag for the next poll of this URL. If the server
          // stopped sending one, forget any prior value so we don't keep
          // revalidating against a header it no longer honors.
          const etag = response.headers.get("ETag");
          if (etag) {
            this.rememberEtag(url, etag);
          } else {
            this.etags.delete(url);
          }

          return response.json();
        })
        .then((data) => {
          // The 304 branch resolved already and returns undefined here.
          if (data === undefined) {
            return;
          }

          if (!("evaluations" in data)) {
            throw new Error(`Invalid payload: ${JSON.stringify(data)}`);
          }

          resolve({ notModified: false, payload: data as EvaluationPayload });
        })
        .catch((error) => {
          this.clearAbortTimeout();
          reject(error);
        });

      this.abortTimeoutId = setTimeout(() => {
        this.abortController?.abort();
      }, this.timeout);
    });
  }

  clearAbortTimeout() {
    clearTimeout(this.abortTimeoutId);
  }
}
