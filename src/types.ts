/**
 * Context value type. Inner values are typed as `unknown` so callers can pass
 * loose objects (e.g. a request payload) without upfront narrowing; the
 * evaluator does runtime type checks per operator. Nested objects are still
 * not meaningful — only scalars and string arrays match any operator at
 * runtime.
 */
export type ContextValue = unknown;

/**
 * Contexts is a map of context type (e.g. "user", "device") to key-value pairs.
 */
export type Contexts = { [key: string]: Record<string, ContextValue> };

/**
 * Alias for Reforge-compatible naming. With ContextValue widened to unknown,
 * Contexts and ContextObj resolve to the same structural type.
 */
export type ContextObj = Contexts;

/**
 * A duration value with both millisecond and second representations.
 */
export type Duration = {
  seconds: number;
  ms: number;
};

/**
 * The possible types a config value can take after parsing.
 */
export type ConfigValue = number | string | boolean | object | Duration | string[] | undefined;

/**
 * Metadata returned alongside each evaluated config value.
 */
export type ConfigEvaluationMetadata = {
  configRowIndex: number;
  conditionalValueIndex: number;
  configType: string;
  configId: string;
};

/**
 * A single evaluated value from the server response.
 */
export type EvaluatedValue = {
  type: string;
  value: any;
};

/**
 * A single evaluation entry in the server response.
 */
export type Evaluation = {
  value: EvaluatedValue;
  configId: string;
  configType: string;
  valueType: string;
  configRowIndex?: number;
  conditionalValueIndex?: number;
};

/**
 * The full response payload from eval-with-context.
 */
export type EvaluationPayload = {
  evaluations: { [key: string]: Evaluation };
  meta?: {
    version?: string;
    environment?: string;
  };
};

/**
 * Callback invoked after every evaluation.
 */
export type EvaluationCallback = (
  key: string,
  value: ConfigValue,
  contexts: Contexts | undefined
) => void;

/**
 * Context upload mode for telemetry.
 */
export type CollectContextMode = "NONE" | "SHAPE_ONLY" | "PERIODIC_EXAMPLE";

/**
 * Options passed to quonfig.init().
 */
export type InitOptions = {
  sdkKey: string;
  context: Contexts;
  /**
   * Single knob that flips api + telemetry URLs in lockstep. Documented path
   * for pointing a browser app at staging or local dev:
   *   `domain: "quonfig-staging.com"` →
   *     api:        https://primary.quonfig-staging.com (+ secondary)
   *     telemetry:  https://telemetry.quonfig-staging.com
   *   `domain: "quonfig.localhost"` → same shape against the local dev proxy.
   *
   * Resolution order (highest wins): explicit `apiUrls`/`telemetryUrl` >
   * `domain` init option > `process.env.QUONFIG_DOMAIN` > `"quonfig.com"`.
   */
  domain?: string;
  /**
   * Ordered list of API base URLs to try (failover order). Escape hatch for
   * deploys that don't follow the `primary.${domain}` / `secondary.${domain}`
   * convention. When set, wins over `domain`.
   */
  apiUrls?: string[];
  /**
   * Convenience alias for callers with a single API base URL. Normalized to
   * `apiUrls = [apiUrl]` when `apiUrls` is not provided. `apiUrls` wins if both
   * are set. Mirrors the singular form accepted by `@quonfig/react`.
   */
  apiUrl?: string;
  /**
   * Base URL for the dedicated telemetry service. Escape hatch for deploys
   * that split telemetry off the primary domain. When set, wins over `domain`.
   */
  telemetryUrl?: string;
  timeout?: number;
  afterEvaluationCallback?: EvaluationCallback;
  collectEvaluationSummaries?: boolean;
  collectLoggerNames?: boolean;
  collectContextMode?: CollectContextMode;
  /**
   * Config key used by the `shouldLog({loggerPath, ...})` convenience overload.
   *
   * When set (e.g. `"log-level.my-app"`), callers can invoke
   * `shouldLog({loggerPath: "com.myapp.Auth", desiredLevel: "DEBUG"})` and
   * the SDK will evaluate the named config with the logger path injected
   * as `contexts["quonfig-sdk-logging"] = { key: loggerPath }` for telemetry
   * auto-capture. Using the `key` property means logger paths flow to the
   * dashboard via the existing example-context telemetry machinery.
   *
   * Callers retain the escape hatch of passing `configKey` directly to
   * `shouldLog`.
   */
  loggerKey?: string;
};

/** Context name under which the logger-path convenience injects the logger path. */
export const QUONFIG_SDK_LOGGING_CONTEXT_NAME = "quonfig-sdk-logging";

/**
 * Telemetry counter for a single config evaluation.
 */
export type ConfigEvaluationCounter = Omit<ConfigEvaluationMetadata, "configType"> & {
  selectedValue: any;
  count: number;
};

/**
 * Arguments for the shouldLog method. Two shapes are supported:
 *
 * 1. `{configKey, ...}` — primitive shape. Evaluates the named config as a
 *    log level. The caller is responsible for any per-logger routing.
 *
 * 2. `{loggerPath, ...}` — convenience shape. Requires `loggerKey` on init.
 *    The SDK uses `loggerKey` as the underlying config key and injects
 *    `contexts["quonfig-sdk-logging"] = { key: loggerPath }` so the logger
 *    path is recorded in telemetry (via the existing example-context
 *    machinery). `loggerPath` is passed through without normalization.
 */
export type ShouldLogArgs =
  | { configKey: string; desiredLevel: string; defaultLevel: string }
  | { loggerPath: string; desiredLevel: string; defaultLevel?: string };

/**
 * Open interface for CLI codegen — extended by `qfg generate --targets react-ts`.
 * The generated quonfig-client-types.d.ts uses `declare module` augmentation to inject
 * flag keys and their exact types into this interface.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FrontEndConfigurationRaw {}

/**
 * Resolves to a typed flag map when FrontEndConfigurationRaw has been extended by codegen,
 * or falls back to Record<string, unknown> for untyped usage.
 */
export type TypedFrontEndConfigurationRaw = keyof FrontEndConfigurationRaw extends never
  ? Record<string, unknown>
  : { [K in keyof FrontEndConfigurationRaw]: FrontEndConfigurationRaw[K] };
