/** Token bucket: capacity = callsPerMinute, refilled continuously. */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly callsPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = callsPerMinute;
    this.lastRefill = this.now();
  }

  tryAcquire(): boolean {
    const at = this.now();
    const elapsedMs = at - this.lastRefill;
    this.tokens = Math.min(
      this.callsPerMinute,
      this.tokens + (elapsedMs / 60_000) * this.callsPerMinute,
    );
    this.lastRefill = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
