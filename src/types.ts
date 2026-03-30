/**
 * Context value types — primitives only. Nested objects are not supported.
 */
export type ContextValue = number | string | boolean;

/**
 * Contexts is a map of context type (e.g. "user", "device") to key-value pairs.
 */
export type Contexts = { [key: string]: Record<string, ContextValue> };

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
export type ContextUploadMode = "none" | "shapes_only" | "periodic_example";

/**
 * Options passed to quonfig.init().
 */
export type InitOptions = {
  sdkKey: string;
  context: Contexts;
  /** @deprecated Use apiUrls instead. If provided, used as a single-element URL list. */
  apiUrl?: string;
  /** Ordered list of API base URLs to try. Defaults to ["https://primary.quonfig.com", "https://secondary.quonfig.com"]. */
  apiUrls?: string[];
  /** Base URL for the dedicated telemetry service. Defaults to https://telemetry.quonfig.com. */
  telemetryUrl?: string;
  timeout?: number;
  afterEvaluationCallback?: EvaluationCallback;
  collectEvaluationSummaries?: boolean;
  collectLoggerNames?: boolean;
  contextUploadMode?: ContextUploadMode;
};

/**
 * Telemetry counter for a single config evaluation.
 */
export type ConfigEvaluationCounter = Omit<ConfigEvaluationMetadata, "configType"> & {
  selectedValue: any;
  count: number;
};

/**
 * Arguments for the shouldLog method.
 */
export type ShouldLogArgs = {
  loggerName: string;
  desiredLevel: string;
  defaultLevel: string;
};
