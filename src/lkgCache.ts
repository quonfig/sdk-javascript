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

const KEY_PREFIX = "quonfig.lkg.v2";
const V1_KEY_PREFIX = "quonfig.lkg.v1";

/**
 * ONE SLOT PER SDK KEY (v2). v1 kept an entry per distinct context
 * (`quonfig.lkg.v1:<sdkKey>:<base64(context)>`) and never removed any, so
 * localStorage grew without bound (and could exhaust the origin quota the
 * customer's own app shares) and the raw context sat in the key. LKG serves
 * the returning visitor in a total outage, and that visitor is the last
 * context this browser held, so one slot is enough. The slot records a hash of
 * the context, never the context, and is served only when the hash matches.
 */
export type LkgEntry = {
  /** Meta.generation stamped on the cached payload (0 if unversioned). */
  generation: number;
  payload: EvaluationPayload;
};

type StoredEntry = LkgEntry & { ctxHash: string };

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
 * The slot for a workspace+environment. The frontend SDK key is the
 * client-side proxy for both (the server resolves them from it). The slot is
 * host-agnostic: an entry persisted while talking to the primary is still
 * served when both primary and secondary are unreachable.
 */
function slotKey(sdkKey: string): string {
  return `${KEY_PREFIX}:${sdkKey}`;
}

/**
 * cyrb53: a fast, synchronous, non-cryptographic 53-bit string hash. The read
 * path is synchronous, so crypto.subtle (async) is not an option; this only
 * has to tell "same context as the cached one" from "different".
 */
function contextHash(contextSig: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < contextSig.length; i += 1) {
    const ch = contextSig.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Read the cached entry for (sdkKey, context), or undefined if absent, for a
 * different context, unreadable or corrupt.
 */
export function readLkg(sdkKey: string, contextSig: string): LkgEntry | undefined {
  const ls = storage();
  if (!ls) return undefined;
  try {
    const raw = ls.getItem(slotKey(sdkKey));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as StoredEntry;
    if (!parsed || typeof parsed.generation !== "number" || !parsed.payload) {
      return undefined;
    }
    if (parsed.ctxHash !== contextHash(contextSig)) return undefined;
    return { generation: parsed.generation, payload: parsed.payload };
  } catch {
    return undefined;
  }
}

// Storages whose v1 entries were already removed, per sdkKey: the scan runs on
// the first write per page, not on every install.
const v1Cleaned = new WeakMap<Storage, Set<string>>();

/** Remove this sdkKey's v1 per-context entries so existing visitors get their quota back. */
function removeV1Entries(ls: Storage, sdkKey: string): void {
  let cleaned = v1Cleaned.get(ls);
  if (!cleaned) {
    cleaned = new Set();
    v1Cleaned.set(ls, cleaned);
  }
  if (cleaned.has(sdkKey)) return;
  cleaned.add(sdkKey);

  const prefix = `${V1_KEY_PREFIX}:${sdkKey}:`;
  const stale: string[] = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (key !== null && key.startsWith(prefix)) stale.push(key);
  }
  stale.forEach((key) => ls.removeItem(key));
}

/**
 * Persist `entry` as the last-known-good for (sdkKey, context), replacing the
 * sdkKey's single slot. Best-effort: a thrown quota or serialization error is
 * swallowed. Callers persist only what the client actually installed (post
 * reject-older guard), so the entry is already monotonic for its context — an
 * older live response is dropped by the guard before it ever reaches here,
 * satisfying "the watermark rule applies to the cache too".
 */
export function writeLkg(sdkKey: string, contextSig: string, entry: LkgEntry): void {
  const ls = storage();
  if (!ls) return;
  try {
    removeV1Entries(ls, sdkKey);
  } catch {
    // Enumeration unsupported / storage disabled — the write below still runs.
  }
  try {
    const stored: StoredEntry = {
      ctxHash: contextHash(contextSig),
      generation: entry.generation,
      payload: entry.payload,
    };
    ls.setItem(slotKey(sdkKey), JSON.stringify(stored));
  } catch {
    // Quota exceeded / serialization failure / storage disabled — ignore.
  }
}
