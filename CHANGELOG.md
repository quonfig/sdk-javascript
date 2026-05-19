# Changelog

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
