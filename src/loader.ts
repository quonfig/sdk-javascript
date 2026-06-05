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
 * Result of a {@link Loader.load}.
 *
 * `payload` ALWAYS holds the evaluations for the context that was just
 * requested — a fresh body on a 200, or the body cached from that context's
 * previous 200 on a 304. This is load-bearing: the SDK keeps a single
 * `_configs` slot shared across contexts, and `updateContext()` switches the
 * context between polls. If a 304 returned no payload (as an earlier version
 * did), the caller would keep whatever context's data happened to be in
 * `_configs` — serving the WRONG context's values. Returning the matching
 * cached payload keeps `updateContext()`'s contract honest.
 *
 * `notModified` is the optimization hint: `true` means the server confirmed
 * this exact (context, version) is unchanged, so a caller whose cache already
 * reflects this context can skip re-applying it.
 */
export type LoaderResult = {
  notModified: boolean;
  payload: EvaluationPayload;
};

type CacheEntry = { etag: string; payload: EvaluationPayload };

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
   * Per-URL cache of {etag, payload} from prior 200 responses, keyed by the
   * FULL request URL (which embeds the encoded context). Keying per-URL —
   * rather than a single shared field like sdk-node — is the safety invariant:
   * an ETag is only ever sent back to the exact URL that minted it, so a context
   * switch (a different URL) can never replay a stale ETag and get a wrong 304.
   * The server's ETag also folds in both the workspace version and the context
   * token, so a stale entry can at worst yield a fresh 200, never stale data.
   *
   * We cache the full payload alongside the ETag so a 304 can return the
   * matching context's evaluations (see {@link LoaderResult}). Bounded as an LRU
   * so it can't grow without limit as contexts change, while still letting a
   * small set of alternating contexts (e.g. a segment MATCH/MISS probe, or
   * multi-tenant switching) each keep their 304 fast-path.
   */
  private cache: Map<string, CacheEntry> = new Map();
  private static readonly CACHE_LIMIT = 16;

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
   * Cache the {etag, payload} for a URL, evicting the least-recently-stored
   * entry once the LRU cap is exceeded. Re-storing a key moves it to the
   * most-recent end.
   */
  private remember(url: string, entry: CacheEntry): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    while (this.cache.size > Loader.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
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

      // Conditional request: if we have a cached {etag, payload} from a prior
      // 200 for THIS exact URL, ask the server to revalidate. A 304 means both
      // the workspace version and the context are unchanged (the server's ETag
      // folds in both), so the cached payload is still correct for this context.
      const requestHeaders: Record<string, string> = headers(this.sdkKey, this.clientVersion);
      const cached = this.cache.get(url);
      if (cached) {
        requestHeaders["If-None-Match"] = cached.etag;
      }

      // Captured from the 200 response headers in the first `.then` so it is
      // still in scope when the parsed body arrives in the second `.then`.
      let responseEtag: string | null = null;

      fetch(url, { signal, headers: requestHeaders })
        .then((response) => {
          this.clearAbortTimeout();

          if (response.status === 304) {
            // Not modified. Return the payload cached for THIS url so the caller
            // always ends up with the current context's evaluations, even if its
            // single config slot currently holds a different context's data.
            if (cached) {
              resolve({ notModified: true, payload: cached.payload });
            } else {
              // 304 without a cached payload should be impossible — we only send
              // If-None-Match when we have a cache entry. If it happens (server
              // quirk), drop any entry so the next poll does a full GET, and
              // surface an error so this URL fails over / retries.
              this.cache.delete(url);
              throw new Error("304 Not Modified with no cached payload");
            }
            return undefined;
          }

          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }

          responseEtag = response.headers.get("ETag");
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

          const payload = data as EvaluationPayload;

          // Cache the {etag, payload} for this URL's next poll. If the server
          // stopped sending an ETag, forget any prior entry so we don't keep
          // revalidating against a header it no longer honors.
          if (responseEtag) {
            this.remember(url, { etag: responseEtag, payload });
          } else {
            this.cache.delete(url);
          }

          resolve({ notModified: false, payload });
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
