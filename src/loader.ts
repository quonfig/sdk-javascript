import { headers, DEFAULT_TIMEOUT, getDefaultApiUrls } from "./apiHelpers";
import { encodeContexts } from "./context";
import type { Contexts, EvaluationPayload, CollectContextMode } from "./types";

export type LoaderParams = {
  sdkKey: string;
  contexts: Contexts;
  /** Ordered list of API base URLs to try for failover. */
  apiUrls?: string[];
  timeout?: number;
  collectContextMode?: CollectContextMode;
  clientVersion?: string;
};

export default class Loader {
  sdkKey: string;
  contexts: Contexts;
  apiUrls: string[];
  timeout: number;
  collectContextMode: CollectContextMode;
  clientVersion: string;
  abortTimeoutId: ReturnType<typeof setTimeout> | undefined;
  abortController: AbortController | undefined;

  constructor({
    sdkKey,
    contexts,
    apiUrls,
    timeout,
    collectContextMode = "PERIODIC_EXAMPLE",
    clientVersion = "",
  }: LoaderParams) {
    this.sdkKey = sdkKey;
    this.contexts = contexts;
    this.apiUrls = (apiUrls ?? getDefaultApiUrls()).map((u) =>
      u.replace(/\/$/, "")
    );
    if (this.apiUrls.length === 0) {
      throw new Error("apiUrls must not be empty");
    }
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.collectContextMode = collectContextMode;
    this.clientVersion = clientVersion;
  }

  url(apiUrl: string): string {
    const encodedContext = encodeContexts(this.contexts);
    return `${apiUrl}/api/v2/configs/eval-with-context/${encodedContext}?collectContextMode=${this.collectContextMode}`;
  }

  load(): Promise<EvaluationPayload> {
    this.abortController?.abort();

    const options = {
      headers: headers(this.sdkKey, this.clientVersion),
    };

    return this.loadWithFailover(options);
  }

  /**
   * Try each API URL in order. Return the first successful result.
   */
  private async loadWithFailover(
    options: { headers: Record<string, string> }
  ): Promise<EvaluationPayload> {
    let lastError: any;

    for (const apiUrl of this.apiUrls) {
      try {
        return await this.fetchFromUrl(apiUrl, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("All API URLs failed");
  }

  private fetchFromUrl(
    apiUrl: string,
    options: { headers: Record<string, string> }
  ): Promise<EvaluationPayload> {
    return new Promise<EvaluationPayload>((resolve, reject) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      const url = this.url(apiUrl);

      fetch(url, { signal, ...options })
        .then((response) => {
          this.clearAbortTimeout();

          if (response.ok) {
            return response.json();
          }
          throw new Error(`${response.status} ${response.statusText}`);
        })
        .then((data) => {
          if (!("evaluations" in data)) {
            throw new Error(`Invalid payload: ${JSON.stringify(data)}`);
          }

          resolve(data as EvaluationPayload);
        })
        .catch((error) => {
          this.clearAbortTimeout();
          reject(error);
        });

      this.abortTimeoutId = setTimeout(() => {
        this.abortController?.abort();
      }, this.timeout);
    });
  }

  clearAbortTimeout() {
    clearTimeout(this.abortTimeoutId);
  }
}
