import "server-only";

import { createHash } from "node:crypto";

import type { Problem } from "@/lib/contract";

/**
 * The strike rule. The guard is a probabilistic classifier: a variant it lets
 * through one time in three gets through if it may be retried freely
 * (1 − (2/3)³ ≈ 70 % in three tries). So every `422 injection` counts a strike
 * on the request's keys (its session, its username, its client address);
 * enough strikes within `windowMs` on one key block that key for `blockMs`.
 * And a refused text is remembered for `refusalMs`: sent again, it gets the
 * same refusal at once instead of a new draw of the guard. Last, few quotes in
 * flight per key: requests sent in parallel would all reach the guard before
 * the first refusal came back.
 *
 * A session or a username is one visitor: `limit` strikes, one quote at a
 * time. An address may be many: a carrier's NAT puts many mobile customers
 * behind one IPv4, hence `ipLimit` strikes and `ipMaxInFlight` quotes.
 */
export interface StrikeLimits {
  limit: number;
  ipLimit: number;
  ipMaxInFlight: number;
  windowMs: number;
  blockMs: number;
  refusalMs: number;
}

/** One key of a request, with what it may hold. */
export interface StrikeKey {
  /** `session:…`, `user:…` or `ip:…`. */
  id: string;
  /** Strikes within the window that block the key. */
  limit: number;
  /** Quotes in flight at once on the key. */
  maxInFlight: number;
}

/**
 * Where strikes, blocks, remembered refusals and quotes in flight live.
 * `MemoryStrikeStore` serves one process; several instances must share one
 * store (Redis: a sorted set per key for the window, `SET … PX` for blocks and
 * refusals, a counter per key for the quotes in flight, its expiry outliving
 * the quoter's timeout) behind this same interface, hence the promises.
 */
export interface StrikeStore {
  /** Milliseconds until none of these keys is blocked; 0 when none is. */
  blockedFor(keys: readonly StrikeKey[]): Promise<number>;
  /** Counts a strike on each key; a key that reaches its limit is blocked. */
  strike(keys: readonly StrikeKey[]): Promise<void>;
  /** The refusal remembered for this cart digest, until it expires. */
  recall(digest: string): Promise<Problem | undefined>;
  remember(digest: string, refusal: Problem): Promise<void>;
  /** Counts one more quote in flight on each key, all or none: false when one is full. */
  acquire(keys: readonly StrikeKey[]): Promise<boolean>;
  release(keys: readonly StrikeKey[]): Promise<void>;
}

/** How many entries the memory store keeps at most; past that, the least recently used go first. */
export interface StoreCapacity {
  keys: number;
  refusals: number;
}

const DEFAULT_CAPACITY: StoreCapacity = { keys: 50_000, refusals: 5_000 };

/** Expired entries are dropped by a sweep, at most this often, run by the store's own calls (no timer). */
const SWEEP_EVERY_MS = 60_000;

/** What the store itself needs: the limits travel with the keys. */
type Timing = Pick<StrikeLimits, "windowMs" | "blockMs" | "refusalMs">;

interface KeyStrikes {
  /** When each strike still inside the window was counted, oldest first. */
  times: number[];
  blockedUntil: number;
}

interface Refusal {
  refusal: Problem;
  expiresAt: number;
}

/** One process's store. Maps keep insertion order: re-inserting an entry on use makes the first one the least recently used. */
export class MemoryStrikeStore implements StrikeStore {
  private readonly strikes = new Map<string, KeyStrikes>();
  private readonly refusals = new Map<string, Refusal>();
  /** Quotes in flight per key; bounded by the requests in flight, every acquire being released in a `finally`. */
  private readonly inFlight = new Map<string, number>();
  private readonly limits: Timing;
  private readonly now: () => number;
  private readonly capacity: StoreCapacity;
  private lastSweep: number;

  constructor(limits: Timing, now: () => number = Date.now, capacity: StoreCapacity = DEFAULT_CAPACITY) {
    this.limits = limits;
    this.now = now;
    this.capacity = capacity;
    this.lastSweep = now();
  }

  async blockedFor(keys: readonly StrikeKey[]): Promise<number> {
    const now = this.now();
    let wait = 0;
    for (const key of keys) wait = Math.max(wait, (this.strikes.get(key.id)?.blockedUntil ?? 0) - now);
    return wait;
  }

  async strike(keys: readonly StrikeKey[]): Promise<void> {
    const now = this.now();
    this.sweep(now);
    for (const { id, limit } of keys) {
      const entry = this.strikes.get(id) ?? { times: [], blockedUntil: 0 };
      entry.times = entry.times.filter((time) => time > now - this.limits.windowMs);
      entry.times.push(now);
      if (entry.times.length >= limit) {
        entry.blockedUntil = now + this.limits.blockMs;
        // The block is the sanction: the count starts again from zero when it ends.
        entry.times = [];
      }
      this.strikes.delete(id);
      this.strikes.set(id, entry);
    }
    this.trim(this.strikes, this.capacity.keys, now);
  }

  async recall(digest: string): Promise<Problem | undefined> {
    const entry = this.refusals.get(digest);
    if (!entry) return undefined;
    this.refusals.delete(digest);
    if (entry.expiresAt <= this.now()) return undefined;
    this.refusals.set(digest, entry);
    return entry.refusal;
  }

  async remember(digest: string, refusal: Problem): Promise<void> {
    const now = this.now();
    this.sweep(now);
    this.refusals.delete(digest);
    this.refusals.set(digest, { refusal, expiresAt: now + this.limits.refusalMs });
    this.trim(this.refusals, this.capacity.refusals, now);
  }

  async acquire(keys: readonly StrikeKey[]): Promise<boolean> {
    if (keys.some(({ id, maxInFlight }) => (this.inFlight.get(id) ?? 0) >= maxInFlight)) return false;
    for (const { id } of keys) this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    return true;
  }

  async release(keys: readonly StrikeKey[]): Promise<void> {
    for (const { id } of keys) {
      const count = (this.inFlight.get(id) ?? 0) - 1;
      if (count > 0) this.inFlight.set(id, count);
      else this.inFlight.delete(id);
    }
  }

  /** Entries held, expired ones included until the next sweep. */
  size(): { keys: number; refusals: number } {
    return { keys: this.strikes.size, refusals: this.refusals.size };
  }

  private sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, entry] of this.strikes) {
      if (entry.blockedUntil <= now && (entry.times.at(-1) ?? -Infinity) <= now - this.limits.windowMs) {
        this.strikes.delete(key);
      }
    }
    for (const [digest, entry] of this.refusals) {
      if (entry.expiresAt <= now) this.refusals.delete(digest);
    }
  }

  /** Over capacity: the expired entries go first, then the least recently used. */
  private trim(map: Map<string, unknown>, max: number, now: number): void {
    if (map.size <= max) return;
    this.sweep(now, true);
    for (const key of map.keys()) {
      if (map.size <= max) return;
      map.delete(key);
    }
  }
}

/** The keys a request is counted on: its session, its username and, when known, its client address. */
export function strikeKeys(
  identity: { sessionId: string; username: string },
  ip: string | undefined,
  limits: StrikeLimits,
): StrikeKey[] {
  const visitor = { limit: limits.limit, maxInFlight: 1 };
  const keys = [
    { id: `session:${identity.sessionId}`, ...visitor },
    { id: `user:${identity.username}`, ...visitor },
  ];
  if (ip) keys.push({ id: `ip:${ip}`, limit: limits.ipLimit, maxInFlight: limits.ipMaxInFlight });
  return keys;
}

/** The memory key of a cart: SHA-256 of its text with CRLF as LF, trimmed. */
export function cartDigest(cart: string): string {
  return createHash("sha256").update(cart.replace(/\r\n/g, "\n").trim()).digest("hex");
}

/** From the environment, read at request time; an absent or invalid value takes the default. */
export function strikeLimits(): StrikeLimits {
  return {
    limit: positiveInteger("STRIKE_LIMIT", 3),
    ipLimit: positiveInteger("IP_STRIKE_LIMIT", 10),
    ipMaxInFlight: positiveInteger("IP_MAX_IN_FLIGHT", 4),
    windowMs: positiveInteger("STRIKE_WINDOW_S", 900) * 1000,
    blockMs: positiveInteger("STRIKE_BLOCK_S", 900) * 1000,
    refusalMs: positiveInteger("REFUSAL_MEMORY_S", 21_600) * 1000,
  };
}

function positiveInteger(variable: string, fallback: number): number {
  const value = Number(process.env[variable]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

let store: StrikeStore | undefined;

/** The process's store, built from the environment at its first use. */
export function strikeStore(): StrikeStore {
  store ??= new MemoryStrikeStore(strikeLimits());
  return store;
}

/** For tests: replaces the process's store; without one, the next use builds it from the environment again. */
export function setStrikeStore(replacement?: StrikeStore): void {
  store = replacement;
}
