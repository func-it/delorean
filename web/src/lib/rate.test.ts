import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryRateLimiter, rateLimit } from "./rate";

const MINUTE = 60_000;

describe("MemoryRateLimiter", () => {
  it("lets through up to the limit within the window, then says how long to wait", async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    const limit = { limit: 3, windowMs: MINUTE };

    expect(await limiter.hit("a", limit)).toBe(0);
    now += 10_000;
    expect(await limiter.hit("a", limit)).toBe(0);
    now += 10_000;
    expect(await limiter.hit("a", limit)).toBe(0);
    now += 10_000;

    // the first of the three leaves the window 30 s from now
    expect(await limiter.hit("a", limit)).toBe(30_000);
  });

  it("slides: the window frees one place at a time", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const limit = { limit: 2, windowMs: MINUTE };
    await limiter.hit("a", limit);
    now += 40_000;
    await limiter.hit("a", limit);

    now += 20_001; // the first left, the second stays
    expect(await limiter.hit("a", limit)).toBe(0);
    expect(await limiter.hit("a", limit)).toBeGreaterThan(0);
  });

  it("does not count what it turns away: a flood does not push the wait further", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const limit = { limit: 1, windowMs: MINUTE };
    await limiter.hit("a", limit);

    for (let i = 0; i < 10; i++) {
      now += 1000;
      await limiter.hit("a", limit);
    }

    now = MINUTE + 1;
    expect(await limiter.hit("a", limit)).toBe(0);
  });

  it("keeps each key on its own", async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const limit = { limit: 1, windowMs: MINUTE };

    expect(await limiter.hit("a", limit)).toBe(0);
    expect(await limiter.hit("b", limit)).toBe(0);
    expect(await limiter.hit("a", limit)).toBeGreaterThan(0);
  });

  it("is off with a limit of 0", async () => {
    const limiter = new MemoryRateLimiter(() => 0);

    for (let i = 0; i < 100; i++) expect(await limiter.hit("a", { limit: 0, windowMs: MINUTE })).toBe(0);
    expect(limiter.size()).toBe(0);
  });

  it("sweeps the addresses that left the window as it is used, with no timer", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const limit = { limit: 5, windowMs: MINUTE };
    for (let i = 0; i < 100; i++) await limiter.hit(`address-${i}`, limit);
    expect(limiter.size()).toBe(100);

    now += 3 * MINUTE;
    await limiter.hit("late", limit);

    expect(limiter.size()).toBe(1);
  });

  it("holds a bounded number of addresses, the least recently seen going first", async () => {
    const limiter = new MemoryRateLimiter(() => 0, 3);
    const limit = { limit: 1, windowMs: MINUTE };
    for (const key of ["a", "b", "c"]) await limiter.hit(key, limit);
    await limiter.hit("a", limit); // a is seen again: b is now the oldest

    await limiter.hit("d", limit);

    expect(limiter.size()).toBe(3);
    expect(await limiter.hit("b", limit)).toBe(0); // forgotten
    expect(await limiter.hit("a", limit)).toBeGreaterThan(0); // kept
  });
});

describe("rateLimit", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is 20 a minute by default", () => {
    vi.stubEnv("IP_RATE_LIMIT", "");
    vi.stubEnv("IP_RATE_WINDOW_S", "");
    expect(rateLimit()).toEqual({ limit: 20, windowMs: 60_000 });
  });

  it.each([
    ["5", "10", { limit: 5, windowMs: 10_000 }],
    ["0", "60", { limit: 0, windowMs: 60_000 }],
    ["-1", "0", { limit: 20, windowMs: 60_000 }],
    ["many", "soon", { limit: 20, windowMs: 60_000 }],
    ["1.5", "2.5", { limit: 20, windowMs: 60_000 }],
  ])("reads IP_RATE_LIMIT=%s and IP_RATE_WINDOW_S=%s", (limit, window, expected) => {
    vi.stubEnv("IP_RATE_LIMIT", limit);
    vi.stubEnv("IP_RATE_WINDOW_S", window);
    expect(rateLimit()).toEqual(expected);
  });
});
