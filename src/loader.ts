import { headers, DEFAULT_TIMEOUT, DEFAULT_HEDGE_DELAY, getDefaultApiUrls } from "./apiHelpers";
import { encodeContexts } from "./context";
import { lkgKey, readLkg } from "./lkgCache";
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
  /**
   * How long the hedge waits for the primary (apiUrls[0]) before ALSO firing
   * the secondary leg(s) in parallel. See {@link DEFAULT_HEDGE_DELAY}.
   */
  hedgeDelay?: number;
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
  /**
   * True when this payload came from the last-known-good localStorage cache
   * because every API URL failed (spec 5h), rather than from the network. The
   * caller marks the served config stale (reason STALE) so consumers know it is
   * non-authoritative until the network recovers.
   */
  stale?: boolean;
};

type CacheEntry = { etag: string; payload: EvaluationPayload };

export default class Loader {
  sdkKey: string;
  contexts: Contexts;
  apiUrls: string[];
  timeout: number;
  hedgeDelay: number;
  collectContextMode: CollectContextMode;
  clientVersion: string;
  /**
   * Every fetch leg currently in flight. The hedge runs the primary and
   * secondary legs concurrently, so a single shared controller (as the old
   * sequential loop used) would clobber one leg's abort with the other's. We
   * track them as a set and abort the whole set when a new load() supersedes an
   * in-flight one (e.g. an updateContext racing a poll tick).
   */
  private inFlight: Set<AbortController> = new Set();

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
    hedgeDelay,
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
    this.hedgeDelay = hedgeDelay ?? DEFAULT_HEDGE_DELAY;
    this.collectContextMode = collectContextMode;
    this.clientVersion = clientVersion;
  }

  url(apiUrl: string): string {
    const encodedContext = encodeContexts(this.contexts);
    return `${apiUrl}/api/v2/configs/eval-with-context/${encodedContext}?collectContextMode=${this.collectContextMode}`;
  }

  /**
   * Load config, returning the FIRST leg to succeed. Thin wrapper over
   * {@link loadHedged} preserving the single-result contract used by callers
   * that only need one payload (and by the loader unit tests). The heal-forward
   * drain (a late, newer primary leg arriving after the secondary painted) is
   * only surfaced through `loadHedged`'s onResult callback, so the polling path
   * in `Quonfig` uses that directly.
   */
  load(): Promise<LoaderResult> {
    let first: LoaderResult | undefined;
    return this.loadHedged((result) => {
      if (first === undefined) first = result;
    }).then(() => first as LoaderResult);
  }

  /**
   * Hedged load (spec 5e). Fires the primary (apiUrls[0]) immediately and, only
   * if the primary is slow (no answer within {@link hedgeDelay}) or errors
   * fast, fires the secondary leg(s) (apiUrls[1+]) IN PARALLEL — it does not
   * cancel the primary. `onResult` is invoked for EVERY leg that returns a usable
   * result, in arrival order, so the caller can drain them all through its
   * reject-older install guard (highest generation wins, not first-arrival): a
   * stale secondary painting first never stops a later, newer primary from
   * healing forward (spec 5f.1).
   *
   * The returned promise resolves as soon as the FIRST leg succeeds (so first
   * paint / init is not blocked on a slow primary) while the remaining legs keep
   * running in the background and continue to feed `onResult`. It rejects only
   * if EVERY leg fails. A fast primary success suppresses the secondary entirely
   * (zero extra requests in the common case).
   */
  loadHedged(onResult: (result: LoaderResult) => void): Promise<void> {
    // Supersede any still-in-flight load (e.g. updateContext racing a poll tick):
    // abort its legs so they can't install over this newer request.
    this.abortInFlight();

    const primaryUrl = this.apiUrls[0];
    const secondaryUrls = this.apiUrls.slice(1);

    return new Promise<void>((resolve, reject) => {
      let pending = 0; // legs currently in flight
      let sawSuccess = false;
      let resolved = false;
      // True while a secondary leg could still be started. A fast primary
      // success flips this off (suppressing the hedge); firing the secondaries
      // flips it off too. We can only reject once it is false and no leg is
      // pending and nothing ever succeeded.
      let moreLegsPossible = secondaryUrls.length > 0;
      let lastError: unknown;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = () => {
        if (resolved || pending !== 0 || moreLegsPossible || sawSuccess) return;
        // Every leg failed and nothing succeeded. Before giving up, serve the
        // last-known-good cache (spec 5h) so a returning visitor with no network
        // gets their last config marked stale instead of an init throw. The
        // caller drains it through the reject-older guard, so it can never
        // regress an established client. Absent a cache entry, reject as before.
        const cached = this.readLastKnownGood();
        if (cached) {
          resolved = true;
          onResult({ notModified: false, payload: cached.payload, stale: true });
          resolve();
          return;
        }
        resolved = true;
        reject(lastError ?? new Error("All API URLs failed"));
      };

      const startLeg = (apiUrl: string) => {
        pending += 1;
        this.fetchFromUrl(apiUrl)
          .then((result) => {
            sawSuccess = true;
            onResult(result);
            if (!resolved) {
              resolved = true;
              resolve(); // first paint: unblock as soon as ANY leg succeeds
            }
          })
          .catch((error) => {
            lastError = error;
          })
          .finally(() => {
            pending -= 1;
            settle();
          });
      };

      const fireSecondaries = () => {
        if (!moreLegsPossible) return;
        moreLegsPossible = false;
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = undefined;
        }
        for (const apiUrl of secondaryUrls) startLeg(apiUrl);
        settle();
      };

      // Primary leg.
      pending += 1;
      this.fetchFromUrl(primaryUrl)
        .then((result) => {
          sawSuccess = true;
          onResult(result);
          if (!resolved) {
            resolved = true;
            resolve();
          }
          // Fast primary success suppresses the hedge entirely.
          moreLegsPossible = false;
          if (hedgeTimer) {
            clearTimeout(hedgeTimer);
            hedgeTimer = undefined;
          }
        })
        .catch((error) => {
          lastError = error;
          // A fast primary error fires the hedge NOW rather than idling out the
          // hedge delay — failover should not wait on a dead primary.
          fireSecondaries();
        })
        .finally(() => {
          pending -= 1;
          settle();
        });

      // Hedge timer: if the primary is merely slow, fire the secondaries after
      // the delay (the primary keeps running so a late primary win still heals
      // forward).
      if (secondaryUrls.length > 0) {
        hedgeTimer = setTimeout(fireSecondaries, this.hedgeDelay);
      }
    });
  }

  /** Abort and forget every in-flight fetch leg. */
  private abortInFlight(): void {
    for (const controller of this.inFlight) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  /**
   * The last-known-good cache entry for the current (sdkKey, context), or
   * undefined if there is none / localStorage is unavailable. Keyed
   * host-agnostically so an entry persisted while talking to the primary is
   * still served when both primary and secondary are unreachable.
   */
  private readLastKnownGood() {
    return readLkg(lkgKey(this.sdkKey, encodeContexts(this.contexts)));
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

  private fetchFromUrl(apiUrl: string): Promise<LoaderResult> {
    return new Promise<LoaderResult>((resolve, reject) => {
      // Leg-local abort + timeout: the hedge runs legs concurrently, so each
      // owns its own controller (registered in inFlight for supersede-abort)
      // and its own timeout. A shared controller would let one leg's timeout
      // abort the other.
      const controller = new AbortController();
      this.inFlight.add(controller);
      const { signal } = controller;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        this.inFlight.delete(controller);
      };

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
          cleanup();

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
          cleanup();
          reject(error);
        });

      timeoutId = setTimeout(() => {
        controller.abort();
      }, this.timeout);
    });
  }
}
