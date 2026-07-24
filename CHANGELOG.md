# Changelog

## 1.2.1 - 2026-07-24

- **Fix: eval-summary telemetry counters now report `reason` as the numeric wire code** (1=STATIC
  2=TARGETING_MATCH 3=SPLIT), matching the backend SDKs. Previously the counter carried the
  OpenFeature-style string form (e.g. `"TARGETING_MATCH"`), which the telemetry ingestion API's
  stricter validation could reject — evaluation-summary batches containing a rule-matched evaluation
  could be dropped as a result (qfg-h8xn). The ingestion service now also accepts and normalizes the
  string form, so existing 0.0.16–1.2.0 clients work without upgrading; this release aligns the SDK
  with the canonical wire contract. Counters without a reason are unchanged (field omitted). No API
  changes.

## 1.2.0 - 2026-07-08

- **`init()` warns when an explicit `apiUrls` disables failover.** The default (and every `domain` /
  `QUONFIG_DOMAIN`-derived) API-URL list carries BOTH a primary and a secondary leg, and the SDK
  hedges/fails over between them (§5e). An explicit `apiUrls` (or the singular `apiUrl` alias)
  replaces that list wholesale, so a single-entry override silently dropped the secondary and
  disabled automatic failover. `init()` now logs a one-line WARN pointing the caller at the fix
  (pass both a primary and a secondary URL). The default two-leg list never warns. Diagnostic only;
  no behavior change, no new dependencies. New README `Failover & QUONFIG_DOMAIN` section documents
  the URL derivation and the failover model.
- **`init()` warns when `timeout <= hedgeDelay`.** The per-leg fetch `timeout` must stay above
  `hedgeDelay` (default 2000ms): if it doesn't, the primary leg is aborted before the hedge timer
  can fire, so the parallel hedge (§5e) silently degrades to error-only sequential failover — the
  secondary is only contacted after the primary fully times out, never concurrently with a
  still-alive-but-slow primary. `init()` now logs a clear warning naming both effective values, and
  the `timeout` / `hedgeDelay` option jsdoc documents the invariant. Diagnostic only; no behavior
  change.
- **Telemetry upload timeout restored to 10s.** 1.1.0's hedge lowered the shared per-request timeout
  to 3s for the eval fetch, which also silently clipped background telemetry POSTs from 10s to 3s
  (they shared one `DEFAULT_TIMEOUT`). Telemetry now uses its own `TELEMETRY_TIMEOUT` (10s), so a
  slow-but-alive telemetry endpoint no longer drops shape/example data that the eval-latency budget
  was never meant to govern. No API change; the `timeout` init option still overrides it.

## 1.1.0 - 2026-06-21

Secondary-delivery failover hardening (project/plans/secondary-delivery-platform.md §5e/5f/5h). All
additive and backward-compatible — pre-watermark servers and existing callers are unaffected.

- **Reject-older install guard (§5f).** The SDK now reads the monotonic `Meta.generation` watermark
  api-delivery already emits on the eval-with-context response and guards every network install
  (initial load + poll): a fresh client installs anything; an unversioned snapshot (`generation`
  absent or `<= 0`, e.g. a pre-watermark server) installs anyway (carve-out); otherwise a payload
  installs only if its generation is strictly greater than the held one. A failover to a lagging
  secondary (whose generation is equal-or-lower, since both delivery legs emit the honest commit
  count — spec 5f.1) can no longer regress or flap an established client. A context switch always
  installs (a different query, generation-incomparable).
- **Parallel hedge (§5e).** `loadWithFailover` is replaced with a hedge: the primary fires first and
  the secondary only if the primary is slow (no answer within the hedge delay, default ~2s) or
  errors fast — then both run in parallel and every leg drains through the reject-older guard, so a
  late but newer primary still wins over a stale secondary that returned first. A fast primary
  success never contacts the secondary. The per-URL timeout drops from 10s to 3s. New `hedgeDelay`
  init option (defaults to ~2s); `timeout` still tunable. (Correction: this 3s applied only to the
  eval fetch, but 1.1.0 also shared the constant with telemetry uploads, unintentionally clipping
  them to 3s; the telemetry timeout is restored to 10s in 1.2.0 above.)
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
