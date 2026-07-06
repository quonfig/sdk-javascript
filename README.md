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
