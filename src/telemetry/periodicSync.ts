import { ExponentialBackoff } from "./exponentialBackoff";
import type { Quonfig } from "../quonfig";

export abstract class PeriodicSync<T> {
  protected data: Map<string, T> = new Map();
  private startAt: Date;
  private syncIntervalFn: () => number;
  protected client: Quonfig;
  private name: string;
  private timeoutID: ReturnType<typeof setTimeout> | undefined;

  constructor(client: Quonfig, name: string, syncInterval?: number) {
    this.client = client;
    this.name = name;
    this.startAt = new Date();
    this.syncIntervalFn = PeriodicSync.calculateSyncInterval(syncInterval);
    this.scheduleNextSync();
  }

  stop(): void {
    clearTimeout(this.timeoutID);
  }

  sync(): void {
    if (this.data.size === 0) return;

    this.logInternal(`${this.name} syncing ${this.data.size} items`);

    const startAtWas = this.startAt;
    this.startAt = new Date();

    this.flush(this.prepareData(), startAtWas);
  }

  protected abstract flush(toShip: Map<string, T>, startAtWas: Date): void;

  private prepareData(): Map<string, T> {
    const toShip = new Map(this.data);
    this.data.clear();
    return toShip;
  }

  private scheduleNextSync(): void {
    const interval = this.syncIntervalFn();
    this.timeoutID = setTimeout(() => {
      this.sync();
      this.scheduleNextSync();
    }, interval);
  }

  private static calculateSyncInterval(syncInterval?: number): () => number {
    if (syncInterval !== undefined) {
      return () => syncInterval;
    }

    const backoff = new ExponentialBackoff(60 * 5, 8);
    return () => backoff.call();
  }

  protected logInternal(message: string): void {
    const loggerName = `quonfig-javascript.quonfig.${this.name}`;

    if (
      this.client.shouldLog(
        {
          loggerName,
          desiredLevel: "debug",
          defaultLevel: "error",
        },
        false
      )
    ) {
      console.log(`${loggerName}: ${message}`);
    }
  }
}
