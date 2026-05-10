# Changelog

## 0.0.16 - 2026-05-10

- Added `getDetails<T>` accessor that returns the resolved value alongside the evaluation `reason`,
  `variant`, and `flagMetadata` for richer client-side telemetry and debugging (qfg-ez8e).
- Declared `engines.node >= 20.9.0` and added a CI matrix to match the supported Node floor across
  the Quonfig SDK family (qfg-y7xh).
- Added Prettier as the repo formatter and wired up a CI gate so unformatted commits fail the push.
