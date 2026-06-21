import type { EvaluationPayload } from "./types";

/**
 * Last-known-good (LKG) config cache, persisted in localStorage (spec 5h).
 *
 * The browser SDK had no client-side persistence — an in-memory ETag cache
 * only — and the loader threw when every API URL failed. The frontend is the
 * primary consumer of the secondary during a Fly outage (a browser is a fresh
 * client on every page load), and the one failure mode the platform plan
 * accepts is a simultaneous GitHub+Fly outage. This cache lets a RETURNING
 * visitor survive even that: on a page load where all URLs fail, the SDK serves
 * the config it last successfully held instead of throwing, marked stale.
 *
 * PRIVACY DECISION (spec 5h, named so it's a decision and not an accident):
 * this persists evaluated config payloads in localStorage, so they now survive
 * across sessions. XSS exposure is roughly unchanged — the payload was already
 * in JS memory — but cross-session persistence on a shared device is new. It is
 * accepted because frontend SDK keys receive only frontend-scoped payloads and
 * confidential config values are ciphertext at rest (AES-GCM), so nothing
 * secret lands here in the clear. Every access is wrapped in try/catch: the
 * cache is a best-effort enhancement and must never throw into the load path
 * (localStorage is absent in SSR/Node, and throws in private-mode / sandboxed
 * iframes / when the quota is exceeded).
 */

const KEY_PREFIX = "quonfig.lkg.v1";

export type LkgEntry = {
  /** Meta.generation stamped on the cached payload (0 if unversioned). */
  generation: number;
  payload: EvaluationPayload;
};

/**
 * Resolve a usable localStorage, or undefined if there isn't one. Reading the
 * property itself can throw (sandboxed iframe with storage disabled), so the
 * access is guarded.
 */
function storage(): Storage | undefined {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls && typeof ls.getItem === "function") return ls;
  } catch {
    // localStorage access threw — treat as unavailable.
  }
  return undefined;
}

/**
 * Cache key for a (workspace+environment, context) pair. The frontend SDK key
 * is the client-side proxy for workspace+environment (the server resolves both
 * from it), and `contextSig` (encodeContexts) carries the evaluated context, so
 * `${sdkKey}:${contextSig}` is exactly the dimension along which an
 * eval-with-context response is unique — the same keying the per-URL ETag cache
 * uses, minus the host (LKG must be primary/secondary-agnostic).
 */
export function lkgKey(sdkKey: string, contextSig: string): string {
  return `${KEY_PREFIX}:${sdkKey}:${contextSig}`;
}

/** Read the cached entry for `key`, or undefined if absent/unreadable/corrupt. */
export function readLkg(key: string): LkgEntry | undefined {
  const ls = storage();
  if (!ls) return undefined;
  try {
    const raw = ls.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LkgEntry;
    if (!parsed || typeof parsed.generation !== "number" || !parsed.payload) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Persist `entry` as the last-known-good for `key`. Best-effort: a thrown quota
 * or serialization error is swallowed. Callers persist only what the client
 * actually installed (post reject-older guard), so the per-context entry is
 * already monotonic — an older live response is dropped by the guard before it
 * ever reaches here, satisfying "the watermark rule applies to the cache too".
 */
export function writeLkg(key: string, entry: LkgEntry): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota exceeded / serialization failure / storage disabled — ignore.
  }
}
