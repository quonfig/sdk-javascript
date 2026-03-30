import { headers, DEFAULT_TIMEOUT } from "../apiHelpers";

export const DEFAULT_TELEMETRY_URL = "https://telemetry.quonfig.com";

export type TelemetryUploaderParams = {
  sdkKey: string;
  telemetryUrl?: string;
  timeout?: number;
  clientVersion: string;
};

export default class TelemetryUploader {
  sdkKey: string;
  telemetryUrl: string;
  timeout: number;
  clientVersion: string;
  abortTimeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor({ sdkKey, telemetryUrl, timeout, clientVersion }: TelemetryUploaderParams) {
    this.sdkKey = sdkKey;
    this.telemetryUrl = telemetryUrl || DEFAULT_TELEMETRY_URL;
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.clientVersion = clientVersion;
  }

  clearAbortTimeout() {
    clearTimeout(this.abortTimeoutId);
  }

  postUrl(): string {
    return `${this.telemetryUrl}/api/v1/telemetry/`;
  }

  /**
   * Post telemetry data to the telemetry endpoint.
   */
  post(data: any): Promise<any> {
    const options = {
      method: "POST",
      headers: {
        ...headers(this.sdkKey, this.clientVersion),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(data),
      keepalive: true, // needed for flushing when the window is closed
    };

    const url = this.postUrl()!;

    return new Promise((resolve, reject) => {
      this.postToEndpoint(url, options, resolve, reject);
    });
  }

  private postToEndpoint(
    url: string,
    options: RequestInit,
    resolve: (value: any) => void,
    reject: (value: any) => void
  ) {
    const controller = new AbortController();
    const { signal } = controller;

    fetch(url, { signal, ...options })
      .then((response) => {
        this.clearAbortTimeout();

        if (response.ok) {
          return response.json();
        }

        console.warn(
          `Quonfig warning: Error uploading telemetry ${response.status} ${response.statusText}`
        );

        return response.status;
      })
      .then((response) => {
        resolve(response);
      })
      .catch((error) => {
        this.clearAbortTimeout();
        reject(error);
      });

    this.abortTimeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeout);
  }
}
