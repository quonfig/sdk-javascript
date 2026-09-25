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

if (quonfig.isEnabled("my-flag")) {
  // ...
}

const color = quonfig.get("button-color");
```

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
