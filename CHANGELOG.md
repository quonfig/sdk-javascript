# Changelog

## 1.1.0 - 2026-06-21

Secondary-delivery failover hardening (project/plans/secondary-delivery-platform.md §5e/5f/5h). All
additive and backward-compatible — pre-watermark servers and existing callers are unaffected.

- **Reject-older install guard (§5f).** The SDK now reads the monotonic `Meta.generation` watermark
  api-delivery already emits on the eval-with-context response and guards every network install
  (initial load + poll): a fresh client installs anything; an unversioned snapshot (`generation`
  absent or `<= 0`, e.g. a pre-watermark server) installs anyway (carve-out); otherwise a payload
  installs only if its generation is strictly greater than the held one. A failover to the depth-1
  secondary (which reports `generation = 1`) can no longer regress or flap an established client. A
  context switch always installs (a different query, generation-incomparable).
- **Parallel hedge (§5e).** `loadWithFailover` is replaced with a hedge: the primary fires first and
  the secondary only if the primary is slow (no answer within the hedge delay, default ~2s) or
  errors fast — then both run in parallel and every leg drains through the reject-older guard, so a
  late but newer primary still wins over a stale secondary that returned first. A fast primary
  success never contacts the secondary. The per-URL timeout drops from 10s to 3s. New `hedgeDelay`
  init option (defaults to ~2s); `timeout` still tunable.
- **Last-known-good cache (§5h).** A new localStorage cache, keyed by SDK key + context and stamped
  with the generation watermark, persists each fresh install. When every API URL fails, the SDK
  serves the cached config marked stale instead of throwing, so a returning visitor survives even a
  simultaneous GitHub+Fly outage. `getDetails()` reports the OpenFeature-standard `STALE` reason and
  a new `stale` getter exposes it; the next successful load heals back to authoritative. The
  watermark rule applies to the cache too — an older live response never regresses it.

  Privacy: config payloads now persist across sessions in localStorage. Frontend keys receive only
  frontend-scoped payloads and confidential values are ciphertext at rest, so nothing secret is
  stored in the clear; cross-session persistence on a shared device is the one new exposure, and it
  is accepted (see §5h).

## 1.0.0 - 2026-06-06

- **Stable 1.0.0 release.** The Quonfig browser/JavaScript SDK is now declared stable. No API or
  behavior changes from 0.0.18 — this is a coordinated 1.0.0 version stamp across the entire Quonfig
  SDK family.

## 0.0.18 - 2026-06-05

- Conditional polling: the loader now sends `If-None-Match` on repeat eval-with-context polls and
  honors a `304 Not Modified` by keeping the cached evaluations instead of re-downloading the full
  payload. The ETag is stored per-request-URL (which embeds the encoded context) and LRU-bounded to
  16 entries, so a context switch can never replay a stale ETag. Steady-state polling collapses to a
  304 when neither the workspace version nor the context has changed (qfg-iikt).
- Fix: a 304 now returns the payload cached for that exact context, so the `updateContext(A)` →
  `updateContext(B)` → `updateContext(A)` pattern can no longer leave the previous context's
  evaluations in the single shared config slot and serve the wrong context's values (qfg-iikt).
- Fix: polling now starts and self-heals even when the very first poll fetch rejects (a startup
  network blip with both primary and secondary briefly unreachable). Previously a rejected bootstrap
  fetch left polling permanently dead — config frozen with no recovery after connectivity returned.
  The recurring loop is now scheduled regardless of the first fetch's outcome, matching the
  steady-state loop's own resilience (qfg-8uw5).

## 0.0.17 - 2026-05-19

- **Breaking (typing-level):** removed the `collectLoggerNames` init option and its internal
  `LoggerAggregator`. The server-side telemetry pipeline never consumed the logger-name event (no
  schema entry, no flatten branch, no ClickHouse table), so this was dead client-side cost.
  TypeScript callers passing `collectLoggerNames: true | false` will get a type error — drop the
  field (qfg-o2fk). Logger-level evaluation via `shouldLog({loggerPath, ...})` is unchanged; logger
  paths still flow to the dashboard through the existing example-context telemetry.

## 0.0.16 - 2026-05-10

- Added `getDetails<T>` accessor that returns the resolved value alongside the evaluation `reason`,
  `variant`, and `flagMetadata` for richer client-side telemetry and debugging (qfg-ez8e).
- Declared `engines.node >= 20.9.0` and added a CI matrix to match the supported Node floor across
  the Quonfig SDK family (qfg-y7xh).
- Added Prettier as the repo formatter and wired up a CI gate so unformatted commits fail the push.
