import type {
  ConfigValue,
  ConfigEvaluationMetadata,
  EvaluatedValue,
  Evaluation,
  EvaluationPayload,
  Duration,
} from "./types";

// The Quonfig duration grammar (integration-test-data tests/duration/grammar.yaml,
// the shared fixture these rules are tested against): P[nD][T[nH][nM][n[.f]S]],
// at least one component, no dangling T, a fraction only on S with at most 9
// digits, total <= P36500D. Full-string anchors and [0-9] (not \d), so no
// newline or non-ASCII digit slips through.
const DURATION_GRAMMAR =
  /^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)(?:\.([0-9]{1,9}))?S)?)?$/;
const MAX_DURATION_MS = 36500 * 86400 * 1000;

/**
 * Parse an ISO 8601 duration string in the Quonfig grammar (e.g. "PT90S",
 * "PT1H30M", "P1DT6H2M1.5S") into a Duration. Milliseconds are exact: the
 * fraction is read as decimal digits (no float arithmetic) and rounded half
 * up to an integer ms count. Returns undefined for anything outside the
 * grammar.
 */
export const parseDuration = (iso: unknown): Duration | undefined => {
  if (typeof iso !== "string") return undefined;
  const match = DURATION_GRAMMAR.exec(iso);
  if (!match) return undefined;

  const [, days, hours, minutes, secs, frac] = match;
  if (days === undefined && hours === undefined && minutes === undefined && secs === undefined) {
    return undefined; // "P" or "PT": no component
  }
  if (iso.endsWith("T")) return undefined; // dangling T ("P1DT")

  // Whole milliseconds before the fraction. Values big enough to lose
  // integer precision are far above the ceiling, so the comparison holds.
  const wholeMs =
    Number(days ?? 0) * 86400000 +
    Number(hours ?? 0) * 3600000 +
    Number(minutes ?? 0) * 60000 +
    Number(secs ?? 0) * 1000;

  const fraction = (frac ?? "").padEnd(9, "0");
  const fractionMs = Number(fraction.slice(0, 3));
  const subMsNanos = Number(fraction.slice(3));

  const truncatedMs = wholeMs + fractionMs;
  if (truncatedMs > MAX_DURATION_MS || (truncatedMs === MAX_DURATION_MS && subMsNanos > 0)) {
    return undefined;
  }

  const ms = subMsNanos >= 500000 ? truncatedMs + 1 : truncatedMs;
  return { ms, seconds: ms / 1000 };
};

/** True for a value shaped like a parsed Duration ({ ms, seconds } numbers). */
export const isDuration = (value: unknown): value is Duration =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Duration).ms === "number" &&
  typeof (value as Duration).seconds === "number";

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
      // Server always sends native JSON (object/array/number/boolean/null).
      // Stringified JSON is illegal on the wire — reject loudly to match
      // sdk-go and sdk-python. No silent pass-through, no JSON.parse fallback.
      if (typeof value === "string") {
        throw new Error(
          "json value must be a native JSON type (object/array/number/boolean/null); stringified JSON is no longer allowed"
        );
      }
      return value as ConfigValue;
    case "string_list":
      return value as string[];
    case "duration":
      // Anything outside the grammar (including a provided ENV_VAR object the
      // server could not resolve) parses to undefined; Config records the
      // error so getDuration returns the default and getDetails reports ERROR.
      return parseDuration(value);
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
  /**
   * Set when the server value could not be coerced to its declared type
   * (today: a duration outside the grammar). The value is then undefined.
   * Never contains the raw value.
   */
  coercionError: string | undefined;

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
    if (type === "duration" && value === undefined && rawValue !== undefined) {
      this.coercionError = `Value for key "${key}" is not a valid ISO 8601 duration`;
    }
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
      if (evaluation.reason !== undefined) metadata.reason = evaluation.reason;
      if (evaluation.ruleIndex !== undefined) metadata.ruleIndex = evaluation.ruleIndex;
      if (evaluation.weightedValueIndex !== undefined) {
        metadata.weightedValueIndex = evaluation.weightedValueIndex;
      }

      configs[key] = new Config(key, parsedValue, ev.type, ev, metadata);
    });

    return configs;
  }
}
