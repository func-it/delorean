import "server-only";

/**
 * Quotes per client address, a sliding window: an address may send `limit`
 * quotes within any `windowMs`; the next one is turned away with the time to
 * wait. It is the first check of the quote route, before the strike rule and
 * before the body is read: a flood costs one lookup. The key is the address
 * as `clientIp` writes it (an IPv6 one by its /64), or `unknown` when there
 * is none, a key all such requests share.
 */
export interface RateLimit {
  /** Quotes per window; 0 turns the limit off. */
  limit: number;
  windowMs: number;
}

/** From the environment, at request time: `IP_RATE_LIMIT` (20) per `IP_RATE_WINDOW_S` (60); 0 turns it off, an invalid value is the default. */
export function rateLimit(): RateLimit {
  return { limit: nonNegativeInteger("IP_RATE_LIMIT", 20), windowMs: positiveInteger("IP_RATE_WINDOW_S", 60) * 1000 };
}

function nonNegativeInteger(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(variable: string, fallback: number): number {
  const value = nonNegativeInteger(variable, fallback);
  return value > 0 ? value : fallback;
}

export interface RateLimiter {
  /** Counts a quote from `key`; the milliseconds to wait when it is over the limit (not counted), 0 when it goes through. */
  hit(key: string, limit: RateLimit): Promise<number>;
}

/** How many addresses are kept at most; past that, the least recently seen go first. */
const DEFAULT_CAPACITY = 50_000;

/** Expired entries are dropped by a sweep, at most this often, run by the limiter's own calls (no timer). */
const SWEEP_EVERY_MS = 60_000;

/** One process's limiter. Maps keep insertion order: re-inserting an address on use makes the first one the least recently seen. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly times = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly capacity: number;
  private lastSweep: number;
  private longestWindow = 0;

  constructor(now: () => number = Date.now, capacity: number = DEFAULT_CAPACITY) {
    this.now = now;
    this.capacity = capacity;
    this.lastSweep = now();
  }

  async hit(key: string, { limit, windowMs }: RateLimit): Promise<number> {
    if (limit <= 0) return 0;
    const now = this.now();
    this.longestWindow = Math.max(this.longestWindow, windowMs);
    this.sweep(now);
    const recent = (this.times.get(key) ?? []).filter((time) => time > now - windowMs);
    this.times.delete(key);
    if (recent.length >= limit) {
      this.times.set(key, recent);
      this.trim();
      return Math.max(1, recent[0] + windowMs - now);
    }
    recent.push(now);
    this.times.set(key, recent);
    this.trim();
    return 0;
  }

  /** Addresses held, expired ones included until the next sweep. */
  size(): number {
    return this.times.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, times] of this.times) {
      if ((times.at(-1) ?? -Infinity) <= now - this.longestWindow) this.times.delete(key);
    }
  }

  private trim(): void {
    for (const key of this.times.keys()) {
      if (this.times.size <= this.capacity) return;
      this.times.delete(key);
    }
  }
}

let limiter: RateLimiter | undefined;

/** The process's limiter, built at its first use. */
export function rateLimiter(): RateLimiter {
  limiter ??= new MemoryRateLimiter();
  return limiter;
}

/** For tests: replaces the process's limiter; without one, the next use builds it again. */
export function setRateLimiter(replacement?: RateLimiter): void {
  limiter = replacement;
}
