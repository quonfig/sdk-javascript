export class ExponentialBackoff {
  private initialDelay: number;
  private maxDelay: number;
  private multiplier: number;
  private delay: number;

  /**
   * @param maxDelay Maximum delay in seconds
   * @param initialDelay Initial delay in seconds (default: 2)
   * @param multiplier Multiplier for each subsequent delay (default: 2)
   */
  constructor(maxDelay: number, initialDelay = 2, multiplier = 2) {
    this.initialDelay = initialDelay;
    this.maxDelay = maxDelay;
    this.multiplier = multiplier;
    this.delay = initialDelay;
  }

  /** Returns the next delay in milliseconds */
  call(): number {
    const delayValue = this.delay;
    this.delay = Math.min(this.delay * this.multiplier, this.maxDelay);
    return delayValue * 1000;
  }
}
