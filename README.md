# @quonfig/javascript

Feature flags and dynamic configuration for the browser. The client fetches an evaluated config
snapshot over HTTP and keeps it fresh by polling, so flag evaluation is a local, synchronous read.

## Install

```bash
npm install @quonfig/javascript
```

## Usage

```js
import { quonfig } from "@quonfig/javascript";

await quonfig.init({
  sdkKey: "your-frontend-sdk-key",
  context: { user: { key: "user-123" } },
});

// init() resolves once config is loaded (see "When config cannot be loaded at
// startup" below). Start polling to pick up flag changes. poll()'s promise
// rejects if its first fetch fails, but the loop keeps running and retrying.
quonfig.poll({ frequencyInMs: 60_000 }).catch(() => {});

if (quonfig.isEnabled("my-flag")) {
  // ...
}

const color = quonfig.get("button-color");
```

### Reading values

| Method                            | Returns                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get(key)`                        | The evaluated value as stored (no coercion), or `undefined` for a missing key or a value that can't be read |
| `isEnabled(key)`                  | `true` only for a boolean config whose value is `true`; `false` otherwise. Never throws                     |
| `getDuration(key, defaultValue?)` | A `{ ms, seconds }` duration, or `defaultValue` (`undefined` when omitted). Never throws                    |
| `getDetails(key)`                 | `{ value, reason, variant, flagMetadata }`, plus `errorCode` when `reason` is `"ERROR"`                     |
| `peek(key)`                       | Same value as `get(key)`, without recording an evaluation (for framework bindings)                          |

These follow the typed-getter contract every Quonfig SDK shares:

- **No string coercion.** A stored string `"true"` is a string: `isEnabled` returns `false`. A
  stored string `"PT1S"` is not a duration: `getDuration` returns your default.
- **A failed read returns your default.** `getDuration` on a config of another type, or on a value
  outside the duration grammar, returns `defaultValue`. `isEnabled` returns `false` for a missing
  key, a non-boolean value or a value that can't be read. A value whose JSON shape does not match
  its declared type (an `int` holding `"twelve"`) reads as `undefined` from `get`, and `getDetails`
  reports `reason: "ERROR"`, `errorCode: "TYPE_MISMATCH"`.
- **One warning per key.** Each of these failed reads logs one `console.warn` per key per client. It
  names the key, never the value. A missing key is logged only by `isEnabled`.

### Switching context

`updateContext(context)` stops serving the previous context's values at once, before its fetch
completes. Until the new context's config arrives the client serves the copy cached in this browser
for that context (marked stale), or nothing (reads return your defaults) when there is none. If the
fetch fails, the client stays on that copy or on defaults; it never serves the previous user's
values for the new one. Re-sending the current context changes nothing.

### When config cannot be loaded at startup

`init()` retries (jittered backoff 0.5s, 1s, 2s, ..., capped at 30s) until it has config or
`initTimeout` (default 5000ms) passes. A last-known-good copy cached in this browser for the
context, or an SSR bootstrap, counts as config: `init()` resolves on it at once and serves those
values marked stale (`quonfig.stale` is `true`, `getDetails()` reports reason `STALE`) until a fetch
succeeds. With neither, `onInitFailure` decides:

| `onInitFailure`    | At `initTimeout`                                               |
| ------------------ | -------------------------------------------------------------- |
| `"fail"` (default) | `init()` rejects with `QuonfigInitError`                       |
| `"wait"`           | `init()` stays pending and keeps retrying until config lands   |
| `"continue"`       | `init()` resolves; `get()` returns `undefined` (code defaults) |

`initTimeout: 0` (or any negative value) runs exactly one attempt and then applies `onInitFailure`:
it never means "no deadline", and it never decides before that attempt finishes. Use
`onInitFailure: "wait"` for no deadline. A non-numeric, `NaN` or `Infinity` value warns and uses
5000ms.

`error.reason` is `"timeout"` when the last attempt hung (every leg in it timed out),
`"unavailable"` when it failed fast (refused, DNS, 5xx), and `"unauthorized"` when every configured
leg rejected the key. Log lines and the error message name each leg by host and `HTTP <status>` (or
a short class such as `network error`); they never carry the SDK key, URL credentials or response
bodies.

A key that every configured leg rejects (401/403/404/410) ends `"fail"` and `"continue"` at once. In
every mode the client keeps retrying in the background until it has live config, then installs it,
notifies subscribers and logs one `[quonfig] init recovered` line. `isReady()` tells you whether the
client holds live config, and `quonfig.error` holds the `QuonfigInitError` (cleared on heal):

```js
import { quonfig, QuonfigInitError } from "@quonfig/javascript";

try {
  await quonfig.init({ sdkKey: "your-frontend-sdk-key", context, initTimeout: 5000 });
} catch (error) {
  // error instanceof QuonfigInitError; error.reason is "timeout", "unavailable" or "unauthorized".
  // The client keeps retrying and heals on its own when the network returns.
}

// Or start on code defaults and let the client heal in the background:
await quonfig.init({ sdkKey: "your-frontend-sdk-key", context, onInitFailure: "continue" });
if (!quonfig.isReady()) console.warn("serving cached/default flags");
```

`poll()` takes over the background retry when you start it. `stopPolling()` hands it back: a client
that is not ready yet (including a pending `init()` under `"wait"`) keeps retrying. Only `close()`
stops it.

### Invalid or revoked SDK key

When a poll fails on every leg and the primary answers 401, 403, 404 or 410, the SDK logs one
`console.error` ("config fetch rejected: the SDK key is invalid or revoked") naming the status and
host, never the key. It keeps serving the current config and slows polling to one fetch every
150-300s (or `frequencyInMs`, if longer) for as long as the page lives. The first 200 or 304 on any
leg logs one `console.info` and polling returns to `frequencyInMs`. `init()` and `updateContext()`
never trigger this slow-poll state; only poll ticks do (`init()` handles a rejected key through
`onInitFailure`, above). A primary 5xx with a secondary 401 is treated as a transient failure.

## Failover & `QUONFIG_DOMAIN`

By default the SDK derives its URLs from a single domain (default `quonfig.com`) and ships a primary
and a secondary config-fetch leg:

```
Role                     URL
------------------------ ---------------------------------
Config fetch (primary)   https://primary.quonfig.com
Config fetch (secondary) https://secondary.quonfig.com
Telemetry                https://telemetry.quonfig.com
```

(This SDK polls HTTP for config; it does not open an SSE stream, so there are no `stream.*` URLs.)

Point all of them at a different environment with the `domain` init option — the documented browser
knob, which flips the config and telemetry URLs in lockstep:

```js
await quonfig.init({
  sdkKey: "your-frontend-sdk-key",
  context: { user: { key: "user-123" } },
  domain: "quonfig-staging.com",
});
```

`QUONFIG_DOMAIN` is also honored, but only where `process.env` exists — Node-side, SSR, or when a
bundler inlines it at build time. A pure browser runtime has no `process.env`, so prefer the
`domain` option there. Resolution order (highest wins): explicit `apiUrls` > `domain` option >
`process.env.QUONFIG_DOMAIN` > `"quonfig.com"`.

**Automatic failover is on by default.** The secondary runs on separate infrastructure; the SDK
hedges to it if the primary is slow and fails over to it if the primary is unreachable.

`apiUrls` replaces the derived list wholesale. To keep automatic failover with custom URLs, **pass
both a primary and a secondary URL**:

```js
await quonfig.init({
  sdkKey: "your-frontend-sdk-key",
  context: { user: { key: "user-123" } },
  apiUrls: ["https://primary.your-proxy.example", "https://secondary.your-proxy.example"],
});
```

A single-URL `apiUrls` (or the singular `apiUrl`) drops the secondary and disables failover, and the
SDK logs a warning at init.

See https://docs.quonfig.com/docs/explanations/architecture/resiliency for the full model.

## Telemetry

The SDK sends evaluation summaries (per flag/config: how often each value was served) to the
telemetry URL so the Quonfig dashboard can show which flags are in use. Context shapes and example
contexts for browser clients are recorded server-side from the config fetch (`collectContextMode`).
Opt out of summaries with `collectEvaluationSummaries: false`. Telemetry never affects flag
evaluation: every failure below is contained in the background reporter.

**How it is sent.**

- One POST every `telemetryFlushIntervalMs` (30s), with at most one POST in flight. A tick that
  fires while a POST is still out is skipped and its data rolls into the next window.
- Each POST has a deadline of `telemetryTimeoutMs` (10s). The eval-fetch `timeout` option does not
  apply to telemetry.
- When a POST fails (timeout, network error, 408, 429 or 5xx), the serialized batch is kept in
  memory for the life of the page and resent unchanged, never merged with newer data, so the server
  can recognize a resend of a batch that did land. Up to 5 batches / 512KB are kept for up to 5
  minutes; beyond that the oldest is dropped, and a single batch larger than the byte cap is sent
  once and never kept. Resends happen no sooner than 30s after a failure and after any `Retry-After`
  the page can read (honored up to 10 minutes), oldest first, then the current window.
- A 401, 403 or 404 means the SDK key or `telemetryUrl` is wrong: the SDK logs one error and
  disables telemetry for the rest of the page. Any other 4xx drops that one batch with an error (the
  server rejected the payload) and telemetry continues.

**When the page goes away.** On `pagehide` the SDK sends the current window once with
`fetch(..., { keepalive: true })` and a 2s deadline, without waiting: unload is never blocked, and
kept batches from an earlier failure are not resent. `close()` does the same (and stops the timer
and removes the `pagehide` listener); `flush()` sends the current window now, and after a failure
respects the 30s floor and `Retry-After`. Neither rejects.

**Logging.** A failed POST logs at debug only. The first batch actually dropped logs one
`console.warn` with the last POST result and queue depth; further drops log at debug with a summary
warning at most every 10 minutes; the first success after failures logs one `console.info` line.
Debug lines print (via `console.debug`) only when the
`log-level.quonfig-javascript.quonfig.telemetry` config evaluates to `DEBUG`.

**Memory.** Everything is bounded: at most `telemetryMaxEvaluationSummaries` (10,000) distinct
flag/config keys per window (keys already seen keep counting at the cap) and the 512KB retained
queue.

```js
await quonfig.init({
  sdkKey: "your-frontend-sdk-key",
  context: { user: { key: "user-123" } },
  // Defaults shown.
  telemetryFlushIntervalMs: 30000,
  telemetryTimeoutMs: 10000,
  telemetryMaxRetainedBatches: 5,
  telemetryMaxRetainedBytes: 524288,
  telemetryMaxRetainedAgeMs: 300000,
  telemetryMaxEvaluationSummaries: 10000,
});
```

Invalid values (non-finite or <= 0) fall back to the default.
