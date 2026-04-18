import type {
  ConfigValue,
  ConfigEvaluationMetadata,
  EvaluatedValue,
  Evaluation,
  EvaluationPayload,
  Duration,
} from "./types";

/**
 * Parse an ISO 8601 duration string (e.g. "PT90S", "PT1H30M", "PT0.5S") into
 * a Duration object with ms and seconds.
 */
const parseDuration = (iso: string): Duration => {
  // Simple parser for ISO 8601 duration: PT[nH][nM][nS]
  let totalSeconds = 0;

  const match = iso.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (match) {
    if (match[1]) totalSeconds += parseFloat(match[1]) * 3600;
    if (match[2]) totalSeconds += parseFloat(match[2]) * 60;
    if (match[3]) totalSeconds += parseFloat(match[3]);
  } else {
    // Fallback: try to parse as just seconds
    const secMatch = iso.match(/(\d+(?:\.\d+)?)/);
    if (secMatch) {
      totalSeconds = parseFloat(secMatch[1]);
    }
  }

  return {
    seconds: totalSeconds,
    ms: totalSeconds * 1000,
  };
};

/**
 * Parse an EvaluatedValue from the server response into a native JS value.
 */
const parseValue = (ev: EvaluatedValue, key: string): ConfigValue => {
  const { type, value } = ev;

  switch (type) {
    case "bool":
      return value as boolean;
    case "int":
      return value as number;
    case "double":
      return value as number;
    case "string":
      return value as string;
    case "json":
      // Server now always sends native JSON (object/array/number/boolean/null).
      // Stringified JSON is no longer supported — see repo-wide migration.
      return value as ConfigValue;
    case "string_list":
      return value as string[];
    case "duration":
      if (typeof value === "string") {
        return parseDuration(value);
      }
      // Handle object format { definition, millis }
      if (typeof value === "object" && value !== null && "millis" in value) {
        return {
          ms: (value as any).millis,
          seconds: (value as any).millis / 1000,
        };
      }
      return parseDuration(String(value));
    case "log_level":
      return value as string;
    default:
      return value;
  }
};

/**
 * Parsed config entry — holds the parsed value, its type, raw server value, and metadata.
 */
export class Config {
  key: string;
  value: ConfigValue;
  type: string;
  rawValue: EvaluatedValue | undefined;
  configEvaluationMetadata: ConfigEvaluationMetadata | undefined;

  constructor(
    key: string,
    value: ConfigValue,
    type: string,
    rawValue?: EvaluatedValue,
    metadata?: ConfigEvaluationMetadata
  ) {
    this.key = key;
    this.value = value;
    this.type = type;
    this.rawValue = rawValue;
    this.configEvaluationMetadata = metadata;
  }

  /**
   * Parse the server evaluation payload into a map of Config objects.
   */
  static digest(payload: EvaluationPayload): { [key: string]: Config } {
    if (payload === undefined) {
      console.trace("Config.digest called with undefined payload");
      return {};
    }

    const configs: { [key: string]: Config } = {};

    if (!payload.evaluations) return configs;

    Object.keys(payload.evaluations).forEach((key) => {
      const evaluation: Evaluation = payload.evaluations[key];
      const ev = evaluation.value;
      const parsedValue = parseValue(ev, key);

      const metadata: ConfigEvaluationMetadata = {
        configRowIndex: evaluation.configRowIndex ?? 0,
        conditionalValueIndex: evaluation.conditionalValueIndex ?? 0,
        configType: evaluation.configType || "config",
        configId: evaluation.configId || "",
      };

      configs[key] = new Config(key, parsedValue, ev.type, ev, metadata);
    });

    return configs;
  }
}
