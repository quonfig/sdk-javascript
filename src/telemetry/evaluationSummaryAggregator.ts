import { Config } from "../config";
import type { ConfigEvaluationMetadata, ConfigEvaluationCounter, EvaluationReason } from "../types";
import type { Quonfig } from "../quonfig";

// Canonical reason wire codes shared with the backend SDKs (sdk-node
// reason.ts: 0=unknown 1=STATIC 2=TARGETING_MATCH 3=SPLIT 4=DEFAULT 5=ERROR).
// STALE is browser-local (LKG cache) with no backend equivalent -> unknown.
const REASON_WIRE_CODES: Record<EvaluationReason, number> = {
  STATIC: 1,
  TARGETING_MATCH: 2,
  SPLIT: 3,
  DEFAULT: 4,
  STALE: 0,
  ERROR: 5,
};

type ConfigEvaluationSummary = {
  key: string;
  type: string;
  counters: ConfigEvaluationCounter[];
};

type ConfigEvaluationSummaries = {
  start: number;
  end: number;
  summaries: ConfigEvaluationSummary[];
};

type TelemetryEvent = {
  summaries: ConfigEvaluationSummaries;
};

type TelemetryEvents = {
  instanceHash: string;
  clientName: string;
  clientVersion: string;
  events: TelemetryEvent[];
};

/**
 * Massage the selected value into the format expected by the telemetry API.
 */
export const massageSelectedValue = (config: Config): any => {
  if (config.rawValue) {
    if (config.type === "json") {
      return { json: config.rawValue.value };
    }
    if (config.type === "duration") {
      return config.rawValue.value;
    }
  }

  if (config.type === "string_list") {
    return { values: config.value };
  }

  return config.value;
};

/**
 * Build a telemetry counter entry for a config evaluation.
 */
export const massageConfigForTelemetry = (
  config: Config,
  metadata: Omit<ConfigEvaluationMetadata, "configType">
): ConfigEvaluationCounter => {
  const { reason, ...rest } = metadata;
  const counter: ConfigEvaluationCounter = {
    ...rest,
    selectedValue: {
      [config.type]: massageSelectedValue(config),
    },
    count: 0,
  };
  if (reason !== undefined) {
    counter.reason = REASON_WIRE_CODES[reason] ?? 0;
  }
  return counter;
};

/**
 * Collects evaluation summaries for the live telemetry window. The reporter
 * (./reporter.ts) owns the tick timer and drains this once per tick.
 *
 * Bounded (P6): at most `maxKeys` distinct (key, configType) pairs per
 * window; a new key beyond the cap is not recorded (drop newest), while keys
 * already in the window keep counting.
 */
export class EvaluationSummaryAggregator {
  data: Map<string, ConfigEvaluationCounter> = new Map();
  private client: Quonfig;
  private maxKeys: number;
  private startAt: Date = new Date();
  private enabled = true;

  constructor(client: Quonfig, maxKeys: number) {
    this.client = client;
    this.maxKeys = maxKeys;
  }

  record(config: Config): void {
    if (!this.enabled || !config?.configEvaluationMetadata) return;

    const { configType, ...metadata } = config.configEvaluationMetadata;
    const key = `${config.key},${configType}`;

    let counter = this.data.get(key);
    if (!counter) {
      if (this.data.size >= this.maxKeys) return;
      counter = massageConfigForTelemetry(config, metadata);
      this.data.set(key, counter);
    }
    counter.count += 1;
  }

  /** Stop recording and clear the window (telemetry disabled, P3). */
  disable(): void {
    this.enabled = false;
    this.data.clear();
  }

  /**
   * Close the live window: serialize it once and reset. Returns undefined for
   * an empty window. This is the only serialization; the transport queue
   * stores and resends these exact bytes (P5, P9).
   */
  drain(): string | undefined {
    if (this.data.size === 0) return undefined;

    const startAtWas = this.startAt;
    this.startAt = new Date();
    const toShip = this.data;
    this.data = new Map();

    const summaries: ConfigEvaluationSummaries = {
      start: startAtWas.getTime(),
      end: this.startAt.getTime(),
      summaries: EvaluationSummaryAggregator.buildSummaries(toShip),
    };
    return JSON.stringify(this.buildEvents(summaries));
  }

  private static buildSummaries(
    data: Map<string, ConfigEvaluationCounter>
  ): ConfigEvaluationSummary[] {
    return Array.from(data).map((entry: [string, ConfigEvaluationCounter]) => {
      const [configKey, configType] = entry[0].split(",");
      const counter = entry[1];

      return {
        key: configKey,
        type: configType,
        counters: [counter],
      };
    });
  }

  private buildEvents(summaries: ConfigEvaluationSummaries): TelemetryEvents {
    return {
      instanceHash: this.client.instanceHash,
      clientName: this.client.clientName,
      clientVersion: this.client.clientVersion,
      events: [{ summaries }],
    };
  }
}
