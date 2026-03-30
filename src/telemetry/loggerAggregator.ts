import type { Severity } from "../logger";
import { PeriodicSync } from "./periodicSync";
import type { Quonfig } from "../quonfig";
import version from "../version";

type LoggerCounter = {
  loggerName: string;
  traces: number;
  debugs: number;
  infos: number;
  warns: number;
  errors: number;
  fatals: number;
};

type LoggersTelemetryEvent = {
  startAt: number;
  endAt: number;
  loggers: LoggerCounter[];
};

type TelemetryEvent = {
  loggers: LoggersTelemetryEvent;
};

type TelemetryEvents = {
  instanceHash: string;
  clientName: string;
  clientVersion: string;
  events: TelemetryEvent[];
};

const SEVERITY_KEY: { [key in Severity]: keyof LoggerCounter } = {
  TRACE: "traces",
  DEBUG: "debugs",
  INFO: "infos",
  WARN: "warns",
  ERROR: "errors",
  FATAL: "fatals",
};

export class LoggerAggregator extends PeriodicSync<LoggerCounter> {
  private maxLoggers: number;

  constructor(client: Quonfig, maxLoggers: number, syncInterval?: number) {
    super(client, "LoggerAggregator", syncInterval ?? 30000);
    this.maxLoggers = maxLoggers;
  }

  record(logger: string, level: Severity): void {
    if (this.data.size >= this.maxLoggers) return;

    if (!this.data.has(logger)) {
      this.data.set(logger, {
        loggerName: logger,
        traces: 0,
        debugs: 0,
        infos: 0,
        warns: 0,
        errors: 0,
        fatals: 0,
      });
    }

    const counter = this.data.get(logger);
    if (counter) {
      const severityKey = SEVERITY_KEY[level] as keyof LoggerCounter;
      (counter[severityKey] as number) += 1;
    }
  }

  protected flush(toShip: Map<string, LoggerCounter>, startAtWas: Date): void {
    const loggers: LoggersTelemetryEvent = {
      startAt: startAtWas.getTime(),
      endAt: new Date().getTime(),
      loggers: Array.from(toShip.values()),
    };

    this.client.telemetryUploader?.post(this.buildEvents(loggers));
  }

  private buildEvents(loggers: LoggersTelemetryEvent): TelemetryEvents {
    return {
      instanceHash: this.client.instanceHash,
      clientName: "javascript",
      clientVersion: version,
      events: [{ loggers }],
    };
  }
}
