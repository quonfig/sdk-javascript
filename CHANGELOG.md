# Changelog

## 1.7.0 - 2026-10-22

- **New: `peek(key)` (qfg-6vno.10).** Returns the same value as `get(key)` but records no evaluation
  summary and does not fire `afterEvaluationCallback` (before load it returns `undefined` without a
  warning). It is for bindings that read a snapshot more often than the application uses the value,
  such as `@quonfig/react`'s `useSyncExternalStore`. `get()` is unchanged.

## 1.6.0 - 2026-10-21

> **UPGRADE (minor):** `init()` now retries for up to `initTimeout` (5s) before it rejects, where it
> used to reject as soon as one hedged attempt failed. The default stays `onInitFailure: "fail"`
> with a cached last-known-good copy counting as config, so who gets which values does not change. A
> failed or stale client now heals on its own when the network returns, without `poll()`.

- **New: `onInitFailure` and `initTimeout` (qfg-9p4i.11).**
  `onInitFailure: "fail" | "wait" | "continue"` picks what `init()` does when no config is available
  by `initTimeout` (default 5000ms, separate from the per-leg `timeout`): `"fail"` (default) rejects
  with the new exported `QuonfigInitError` (`.reason` is `"timeout"`, `"unavailable"` or
  `"unauthorized"`), `"wait"` keeps `init()` pending until config arrives, and `"continue"` resolves
  on code defaults. A cached last-known-good copy or an SSR bootstrap resolves `init()` at once in
  every mode. Until the timeout, attempts repeat with jittered backoff (0.5s, 1s, 2s, ..., capped at
  30s). A key every leg rejects (401/403/404/410) rejects `"fail"` and resolves `"continue"` at
  once; `"wait"` keeps retrying. An unknown value warns once and uses `"fail"`.
- **Cross-SDK init conformance (qfg-9p4i.17.7, qfg-9p4i.16).**
  - `init()` decides `"unauthorized"` only when every configured leg answered 401/403/404/410, never
    from the primary alone; the line reads `SDK key rejected (<status>) by primary and secondary`.
    Under `"wait"` it logs at WARN, not ERROR.
  - `QuonfigInitError.reason` is `"timeout"` when the last attempt hung (every leg timed out) or
    none completed, `"unavailable"` otherwise (was: `"unavailable"` once any attempt had failed).
  - `initTimeout <= 0` runs exactly one attempt and then applies `onInitFailure` (was: `0` decided
    before any fetch could finish; negatives silently became 5000ms). `NaN`/`Infinity` warn and use
    5000ms.
  - Init log lines, the init error message and its `cause` carry hosts and `HTTP <status>` only:
    fetch errors that quote the request URL (credentials, encoded context) become `network error`,
    and payload/JSON errors no longer echo the response body.
  - `stopPolling()` no longer stops the init/background retry, so a pending `init()` under `"wait"`
    can no longer hang forever.
- **New: `isReady()` and `error`.** `isReady()` is true once live config for the current context is
  installed or confirmed (false while serving a cached copy or defaults). `error` holds the
  `QuonfigInitError` the latest `init()` rejected with and clears on heal. Subscribers are notified
  when either changes, and both return the same value until they change, so `useSyncExternalStore`
  callers stay stable.
- **Fix: no permanently dead clients.** A client that is not ready after `init()` settles (a caught
  rejection, `"continue"`, or a stale cached copy) keeps retrying in the background with the same
  backoff and heals: it installs the config, `isReady()` turns true, and one
  `[quonfig] init recovered` line is logged at INFO. `poll()` takes over that retry when started,
  `stopPolling()` hands it back, and `close()` stops it.
- **Logging (design doc section C).** One WARN on the first failed attempt naming each leg's host
  and error (`primary=<host>: <error>; secondary=<host>: <error>`, never the key), progress WARNs,
  an ERROR at the `"fail"` timeout, a WARN at the `"continue"`/`"wait"` timeout, and "still not
  connected" WARNs while not ready (every 30s for 5 minutes, then every 5 minutes). `@quonfig/react`
  and `@quonfig/react-native` inherit this on their next pin bump.
- **Fix: a background heal now notifies subscribers after readiness flips.** When the heal installed
  config, subscribers were notified before `isReady()` turned true and not again after, so
  `@quonfig/react`'s `useQuonfig()` stayed on `isReady: false`, the old `error` and
  `source: "defaults"` after `init recovered` unless `pollInterval` was set (found on React Native).
- **Logging follow-ups (section C).** The `"continue"` timeout WARN says "This instance may
  disagree"; the heal INFO names the leg and version (`... via primary (version <v>)`); the "still
  not connected" WARN runs on its own 30s / 5min timer instead of waiting for the next retry
  attempt, which the backoff could push out past the first interval.
- **Logging: starting on a cached copy is visible (section C).** `init()` resolving on the cached
  last-known-good copy now logs one WARN, `STARTING ON CACHED CONFIG from <age> ago` (or
  `(age unknown)` for a copy cached by an older release), naming each leg's error; later attempts
  are covered by the "still not connected ... serving cache" WARN. Cached copies now record when
  they were written.
- **Fix: the `initTimeout` starts on a cached copy when one exists.** When the network hangs, the
  attempt in flight has not reached the cache by the timeout, so `"continue"` logged
  `STARTING ON CODE DEFAULTS` and `"fail"` rejected while a cached copy was available. At the
  timeout every mode now installs the cached copy, resolves `init()` and logs
  `STARTING ON CACHED CONFIG from <age> ago`. Without a cached copy nothing changes.

## 1.5.1 - 2026-10-16

- **Fix: eval-summary telemetry no longer serializes the value on every read (qfg-23uf).** 1.5.0
  keyed each per-value counter by `JSON.stringify` of the selected value on every `get()`, so a 60KB
  JSON config cost about 212us per read against about 0.14us with summaries off. The counter
  identity is now computed once per installed config, and a repeat read in the same window is a
  counter increment. Counters and the telemetry payload are unchanged. `@quonfig/react` and
  `@quonfig/react-native` inherit it on their next pin bump.

## 1.5.0 - 2026-10-16

> **UPGRADE:** retry cadence and log levels change after a rejected 401/403/404/410 fetch cycle; a
> revoked key logs one config ERROR.

- **New: polling slows down for an invalid or revoked SDK key (qfg-goi1.10.29).** A poll cycle in
  which every leg failed and the primary answered 401, 403, 404 or 410 now logs one `console.error`
  ("config fetch rejected: the SDK key is invalid or revoked (check the SDK key)", with the status
  and the primary host, never the key) in place of the "poll failed" warning. Each later poll waits
  `max(T, frequencyInMs)`, with T uniform in 150-300s and re-drawn each time: no doubling, and it
  never stops. Probes log at DEBUG. The first 200 or 304 on any leg (the secondary included) logs
  one `console.info` and polling returns to `frequencyInMs`; a later rejected cycle enters again. A
  primary 5xx with a secondary 401 keeps today's transient handling. Detection now runs before the
  last-known-good fallback, so a returning visitor with a revoked key is caught too; serving the
  last-known-good copy is unchanged. `init()` and `updateContext()` never enter this state.
  `@quonfig/react` and `@quonfig/react-native` inherit it on their next pin bump.

- **Fix: overlapping `init()` calls install only the newer context (qfg-goi1.10.12).** Each `init()`
  builds its own loader, so when an older `init()`'s response landed after a newer one's, the client
  installed the older context's values while `contexts` said the newer one. A result now installs
  only if it was fetched for the client's current context. This also covers a load still in flight
  when `updateContext(ctx, true)` switches the context: its result is dropped instead of served
  under the new context.
- **Fix: `stale` clears when the network recovers at the same generation.** A client serving its
  last-known-good copy stayed `stale` (reason `STALE`) after a later fetch succeeded with the same
  generation, because only an install cleared it. Any live response for the held context now does.
- **Fix: eval-summary telemetry keeps a counter per evaluated value.** Counters were keyed by config
  key and type, so when a flag's value or rule changed mid-window every evaluation was counted under
  the first value seen. Counters are now keyed by config id, rule, weighted value and selected
  value, as the other SDKs do. `@quonfig/react` and `@quonfig/react-native` inherit the fix.
- **Docs: the README shows `poll()` after `init()` and what happens when `init()` rejects.**

## 1.4.0 - 2026-10-09

- **Fix: a failed poll tick is no longer an unhandled promise rejection.** During an outage with no
  last-known-good entry, every tick rejected with no handler: Node exits on the first one, and
  browsers report each to error trackers. The loop now keeps the current config, warns once per
  outage, and keeps polling.
- **Fix: one malformed evaluation no longer hangs `init()` or stops polling.** A bad entry (a `json`
  value sent as a string, or a null value) made the whole payload fail inside the loader, which then
  never settled. Each key is now decoded on its own: the bad key returns `undefined` and
  `getDetails` reports `reason: "ERROR"`, `errorCode: "TYPE_MISMATCH"` (the same path as a malformed
  duration), and the other keys load. A load also always settles if installing a result throws.
- **Fix: the per-leg fetch `timeout` covers the response body.** It was cleared when headers
  arrived, so a server that sent headers and then stalled hung the load with no deadline.
- **Fix: a load replaced by `updateContext()` can no longer install the previous context's values
  (qfg-goi1.2.7).** When `updateContext()` raced an in-flight refresh or poll tick, a leg of the
  older load that still completed was installed under the old context, so the client could serve
  user A's flags while `contexts` said user B. The aborted older load also counted as a primary
  failure and fired the secondary leg, and its hedge timer kept running. A replaced load now does
  nothing: no install, no secondary leg, no last-known-good, and its promise settles with the load
  that replaced it instead of rejecting with the abort.
- **Fix: `updateContext(ctx, true)` followed by `poll()` installs the new context's values
  (qfg-goi1.2.48).** `skipLoad` changed the context but not the one the loader fetched for, and
  `poll()` did not sync it, so the first poll fetch was for the previous context and was installed,
  and written to the last-known-good cache, as the new one's. At the same generation the later,
  correct fetches were dropped as "not newer", so user B saw user A's flags until the next publish,
  and an offline reload for B served A's values as stale. `poll()` and `updateContext(ctx, true)`
  now point the loader at the current context, and every leg of a load (and its last-known-good
  fallback) is for the context the load started with.
- **Fix: `close()` or `stopPolling()` during the first `poll()` fetch no longer restarts polling.**
  A second `poll()` call also no longer leaves two loops running.
- **Fix: config keys that match `Object.prototype` names** (for example `constructor`) are no longer
  found when absent; `getDetails` reports `FLAG_NOT_FOUND`.
- **Fix: `base64Encode` (used for the context in the fetch URL) is UTF-8 in every runtime.** Without
  `TextEncoder` (React Native) it produced Latin-1 for accented text and threw above U+00FF; without
  `window` (Web/Service Workers, Cloudflare Workers) it threw. Output on modern browsers and Node is
  unchanged.
- **Fix: importing the SDK no longer requires `crypto.getRandomValues`.** The telemetry instance id
  is created on first use and falls back to a non-cryptographic random id.
- **Fix: the last-known-good cache keeps one entry per SDK key.** It stored one localStorage entry
  per distinct context and never removed any, which could fill the origin's quota (breaking the
  app's own `localStorage` writes) and kept the raw context in the key. The entry is now
  `quonfig.lkg.v2:<sdkKey>` with a hash of the context, served only for the same context. Old
  `quonfig.lkg.v1:<sdkKey>:*` entries are removed on the first write.
- **Change: `shouldLog({loggerPath})` no longer adds `quonfig-sdk-logging` to the client context.**
  It changed every later fetch's context, which let an older config generation replace a newer one
  and changed the inputs to every flag. The browser evaluates server-side once per fetched context,
  so the logger path never selected per-logger rules. Logger paths from the browser no longer appear
  in example contexts.
- **Packaging:** removed the `module` field (it named `dist/index.mjs`, which was never built;
  bundlers fall back to `main`) and the `lint` script (eslint is not installed).

## 1.3.2 - 2026-10-05

- **Fix: durations are parsed with the Quonfig grammar (qfg-2agi.14).** `getDuration` read only
  `PT…` values and fell back to "first number = seconds", so valid stored values with a day
  component were wrong (`P1D` and `P1DT6H2M1.5S` both returned 1 second) and invalid ones returned
  plausible numbers (`P1W` -> 1s, `PT-5S` -> 5s, `5m` -> 5s). The parser now accepts exactly
  `P[nD][T[nH][nM][n[.f]S]]` (fraction on seconds only, at most 9 digits, at most `P36500D`) with
  exact millisecond rounding (half up), tested against the shared fixture
  `integration-test-data/tests/duration/grammar.yaml`.
- **A malformed duration returns the default.** A value outside the grammar, including an unresolved
  provided (ENV_VAR) object, now makes `getDuration` return `undefined` with one `console.warn` per
  key (without the raw value) instead of returning a wrong number or throwing. `getDetails` reports
  `reason: "ERROR"`, `errorCode: "TYPE_MISMATCH"`, and evaluation telemetry no longer carries the
  raw string. The unused `{definition, millis}` duration shape is no longer accepted.
- **Fix: `hydrate()` types values by shape.** A `{ms, seconds}` object is hydrated as a `duration`,
  a string array as `string_list` and any other object as `json` (previously all were typed
  `string`), so `hydrate(extract())` round-trips durations.

## 1.3.1 - 2026-09-29

- **Fix: the `<script>`-tag bundle was never published (qfg-cna3).** `dist/quonfig.bundle.js` (which
  sets `window.quonfig`) was only produced by the manual `bundle` script, so no published version
  shipped it and `https://cdn.jsdelivr.net/npm/@quonfig/javascript@1/dist/quonfig.bundle.js`
  returned 404. `npm run build` (used by `prepublishOnly` and the release workflow) now runs
  `bundle` after `tsc`.

## 1.3.0 - 2026-09-25

- **Telemetry transport policy (qfg-y8je.11).** Telemetry POSTs get their own 10s deadline
  (`telemetryTimeoutMs`); the eval-fetch `timeout` option no longer applies to telemetry. A failed
  batch (timeout, network error, 408, 429, 5xx) is kept in memory for the life of the page and
  resent byte-for-byte (never merged, so the server dedups a resend of a batch that did land), no
  sooner than 30s after the failure and after any readable `Retry-After` (up to 10 min). The
  retained queue is capped at 5 batches / 512KB / 5 min (oldest dropped; a batch larger than the
  byte cap is never kept). At most one POST is in flight. 401/403/404 disable telemetry for the page
  with one error; any other 4xx drops that batch with one error. Logging: a failed POST logs at
  debug, one `console.warn` when data is actually dropped (then a summary at most every 10 min), one
  `console.info` on recovery. Before this, every non-2xx logged a warning and every failed batch was
  lost.
- **Fix: parallel telemetry POSTs shared one abort timer**, so one request finishing cleared the
  other's deadline (it could then hang with no timeout). Each request now owns its timer, cleared
  when it settles.
- **Fix: a telemetry network error was an unhandled promise rejection.** It is now caught and
  treated as retryable.
- **Fix: `close()` left the telemetry timer armed when the final POST failed** (it rejected before
  stopping timers). `close()` now stops polling and the telemetry timer first, sends the current
  window once with a 2s deadline and `keepalive`, never rejects, and does not resend kept batches.
- **`pagehide` replaces `beforeunload`** for the final flush: the live window is sent once with
  `fetch(..., { keepalive: true })` and a 2s deadline without blocking unload. `close()` removes the
  listener.
- **Flush interval is now an option** (`telemetryFlushIntervalMs`, default 30s, unchanged).
- **Memory cap:** evaluation-summary keys per window drop from 100,000 to 10,000
  (`telemetryMaxEvaluationSummaries`), the uniform cap across SDKs; a key already in the window
  keeps counting at the cap.
- **New options:** `telemetryFlushIntervalMs`, `telemetryTimeoutMs`, `telemetryMaxRetainedBatches`,
  `telemetryMaxRetainedBytes`, `telemetryMaxRetainedAgeMs`, `telemetryMaxEvaluationSummaries`.
  Invalid values (non-finite or <= 0) fall back to the default.
- `TelemetryUploader` (the `telemetryUploader` accessor) gains `send()`; `post()` keeps its behavior
  with a per-request deadline, and `clearAbortTimeout()` is a deprecated no-op. No wire change, no
  removed public API, no new dependencies.

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
