import { PeriodicSync } from "./periodicSync";
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

export class EvaluationSummaryAggregator extends PeriodicSync<ConfigEvaluationCounter> {
  private maxKeys: number;

  constructor(client: Quonfig, maxKeys: number, syncInterval?: number) {
    super(client, "EvaluationSummaryAggregator", syncInterval ?? 30000);
    this.maxKeys = maxKeys;
  }

  record(config: Config): void {
    if (this.data.size >= this.maxKeys) return;

    if (config?.configEvaluationMetadata) {
      const { configType, ...metadata } = config.configEvaluationMetadata;
      const key = `${config.key},${configType}`;

      if (!this.data.has(key)) {
        this.data.set(key, massageConfigForTelemetry(config, metadata));
      }

      const counter = this.data.get(key);
      if (counter) {
        counter.count += 1;
      }
    }
  }

  protected flush(
    toShip: Map<string, ConfigEvaluationCounter>,
    startAtWas: Date
  ): Promise<unknown> | void {
    const summaries: ConfigEvaluationSummaries = {
      start: startAtWas.getTime(),
      end: new Date().getTime(),
      summaries: EvaluationSummaryAggregator.buildSummaries(toShip),
    };

    return this.client.telemetryUploader?.post(this.buildEvents(summaries));
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
