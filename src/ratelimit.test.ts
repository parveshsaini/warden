import { describe, expect, it } from "vitest";
import { RateLimiter } from "./ratelimit.js";

describe("RateLimiter", () => {
  it("allows a burst up to the budget, then denies", () => {
    const limiter = new RateLimiter(3, () => 0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now); // one token per second
    for (let i = 0; i < 60; i += 1) limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);
    now += 1_000;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("caps refill at the budget", () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    now += 3_600_000; // an hour later the bucket holds 2 tokens, not 120
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });
});
