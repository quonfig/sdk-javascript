/**
 * Pluggable logger for SDK-internal log lines (init progress and failure,
 * recovery, auth rejections, poll and telemetry failures, read warnings).
 *
 * Same shape as `@quonfig/node`'s `logger` option, and matches `console`,
 * Pino, Winston and Bunyan, so apps can pass their existing logger. `warn`
 * and `error` are required; `debug` and `info` are optional and become
 * no-ops when the supplied logger does not implement them.
 */
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** {@link Logger} with every level present. Produced by {@link normalizeLogger}. */
export interface NormalizedLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const NOOP = (): void => {};

/**
 * The default: `console`, looked up at call time (so a later spy or
 * replacement of `console.warn` still sees the line). Messages already carry
 * their own `[quonfig]` / `Quonfig warning:` prefix, so the output is
 * byte-identical to the SDK's historical direct `console.*` calls.
 */
export const consoleLogger: NormalizedLogger = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/**
 * Normalize a user-supplied {@link Logger} (or undefined) into a
 * {@link NormalizedLogger}.
 *
 * - `undefined` -> {@link consoleLogger}.
 * - A supplied logger -> passthrough; a missing `debug`/`info` is a no-op.
 */
export function normalizeLogger(logger: Logger | undefined): NormalizedLogger {
  if (!logger) return consoleLogger;
  return {
    debug: logger.debug ? logger.debug.bind(logger) : NOOP,
    info: logger.info ? logger.info.bind(logger) : NOOP,
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  };
}
