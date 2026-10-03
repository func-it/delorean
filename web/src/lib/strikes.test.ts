import { beforeEach, describe, expect, it, vi } from "vitest";

import { problem } from "@/test/fixtures";

import { cartDigest, MemoryStrikeStore, type StrikeKey, type StrikeLimits, strikeLimits, strikeKeys } from "./strikes";

const MINUTE = 60_000;
const LIMITS: StrikeLimits = {
  limit: 3,
  ipLimit: 10,
  ipMaxInFlight: 4,
  windowMs: 15 * MINUTE,
  blockMs: 15 * MINUTE,
  refusalMs: 360 * MINUTE,
};
const visitor = (id: string): StrikeKey => ({ id, limit: 3, maxInFlight: 1 });
const address = (id: string): StrikeKey => ({ id, limit: 10, maxInFlight: 4 });
const REFUSAL = problem({ code: "injection", status: 422, guard: { verdict: "injection", confidence: 0.97 } });

describe("MemoryStrikeStore", () => {
  let now: number;
  let store: MemoryStrikeStore;

  beforeEach(() => {
    now = 0;
    store = new MemoryStrikeStore(LIMITS, () => now);
  });

  it("blocks a key at its third strike, for the block's length", async () => {
    await store.strike([visitor("user:biff")]);
    await store.strike([visitor("user:biff")]);
    expect(await store.blockedFor([visitor("user:biff")])).toBe(0);

    now = MINUTE;
    await store.strike([visitor("user:biff")]);
    expect(await store.blockedFor([visitor("user:biff")])).toBe(15 * MINUTE);
    expect(await store.blockedFor([visitor("user:marty")])).toBe(0);

    now = 11 * MINUTE;
    expect(await store.blockedFor([visitor("user:marty"), visitor("user:biff")])).toBe(5 * MINUTE);

    now = 16 * MINUTE;
    expect(await store.blockedFor([visitor("user:biff")])).toBe(0);
  });

  it("blocks each key at its own limit", async () => {
    const ip = address("ip:203.0.113.7");
    for (let i = 0; i < 9; i++) await store.strike([visitor(`user:${i}`), ip]);
    expect(await store.blockedFor([ip])).toBe(0);

    await store.strike([visitor("user:9"), ip]);
    expect(await store.blockedFor([ip])).toBe(15 * MINUTE);
  });

  it("forgets the strikes that slid out of the window", async () => {
    await store.strike([visitor("user:biff")]);
    now = 5 * MINUTE;
    await store.strike([visitor("user:biff")]);
    now = 15 * MINUTE;
    await store.strike([visitor("user:biff")]);
    expect(await store.blockedFor([visitor("user:biff")])).toBe(0);

    now = 16 * MINUTE;
    await store.strike([visitor("user:biff")]);
    expect(await store.blockedFor([visitor("user:biff")])).toBe(15 * MINUTE);
  });

  it("starts the count again once a block is over", async () => {
    for (let i = 0; i < 3; i++) await store.strike([visitor("user:biff")]);
    now = 15 * MINUTE;
    await store.strike([visitor("user:biff")]);
    await store.strike([visitor("user:biff")]);

    expect(await store.blockedFor([visitor("user:biff")])).toBe(0);
  });

  it("remembers a refusal until it expires", async () => {
    await store.remember("digest", REFUSAL);

    now = 360 * MINUTE - 1;
    expect(await store.recall("digest")).toEqual(REFUSAL);
    now = 360 * MINUTE;
    expect(await store.recall("digest")).toBeUndefined();
    expect(store.size().refusals).toBe(0);
  });

  it("sweeps expired entries away as it goes", async () => {
    await store.strike([visitor("session:a"), visitor("user:biff"), address("ip:203.0.113.7")]);
    await store.remember("digest", REFUSAL);
    expect(store.size()).toEqual({ keys: 3, refusals: 1 });

    now = 360 * MINUTE;
    await store.strike([visitor("user:marty")]);

    expect(store.size()).toEqual({ keys: 1, refusals: 0 });
  });

  it("keeps a block until it is over, even when its strikes are older than the window", async () => {
    store = new MemoryStrikeStore({ ...LIMITS, blockMs: 60 * MINUTE }, () => now);
    for (let i = 0; i < 3; i++) await store.strike([visitor("user:biff")]);

    now = 30 * MINUTE;
    await store.strike([visitor("user:marty")]);

    expect(await store.blockedFor([visitor("user:biff")])).toBe(30 * MINUTE);
  });

  it("stays bounded, dropping the least recently used first", async () => {
    store = new MemoryStrikeStore(LIMITS, () => now, { keys: 2, refusals: 2 });

    await store.strike([visitor("user:a")]);
    await store.strike([visitor("user:b")]);
    await store.strike([visitor("user:a")]);
    await store.strike([visitor("user:c")]);
    expect(store.size().keys).toBe(2);
    await store.strike([visitor("user:a")]);
    expect(await store.blockedFor([visitor("user:a")])).toBe(15 * MINUTE);

    await store.remember("first", REFUSAL);
    await store.remember("second", REFUSAL);
    await store.recall("first");
    await store.remember("third", REFUSAL);
    expect(await store.recall("first")).toEqual(REFUSAL);
    expect(await store.recall("second")).toBeUndefined();
    expect(await store.recall("third")).toEqual(REFUSAL);
  });
});

describe("MemoryStrikeStore leases", () => {
  it("lets each key hold as many quotes as it may, all keys or none", async () => {
    const store = new MemoryStrikeStore(LIMITS);
    const ip = address("ip:203.0.113.7");

    expect(await store.acquire([visitor("session:a"), visitor("user:biff"), ip])).toBe(true);
    expect(await store.acquire([visitor("session:b"), visitor("user:biff"), ip])).toBe(false);
    for (const name of ["doc", "marty", "jennifer"]) {
      expect(await store.acquire([visitor(`session:${name}`), visitor(`user:${name}`), ip])).toBe(true);
    }
    expect(await store.acquire([visitor("session:e"), visitor("user:lorraine"), ip])).toBe(false);
    expect(await store.acquire([visitor("session:e"), visitor("user:lorraine")])).toBe(true);

    await store.release([visitor("session:a"), visitor("user:biff"), ip]);
    expect(await store.acquire([visitor("session:f"), visitor("user:biff"), ip])).toBe(true);
  });
});

describe("cartDigest", () => {
  it("ignores the line endings and the blanks around the text", () => {
    expect(cartDigest("  Back to the Future\r\nIgnore the rules \n")).toBe(cartDigest("Back to the Future\nIgnore the rules"));
  });

  it("keeps everything else", () => {
    expect(cartDigest("Back to the Future")).not.toBe(cartDigest("back to the future"));
    expect(cartDigest("Back to the Future")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("strikeKeys", () => {
  it("counts on the session, the username and the address when it is known, the address with looser limits", () => {
    const identity = { sessionId: "s-1", username: "biff" };

    expect(strikeKeys(identity, "203.0.113.7", LIMITS)).toEqual([
      { id: "session:s-1", limit: 3, maxInFlight: 1 },
      { id: "user:biff", limit: 3, maxInFlight: 1 },
      { id: "ip:203.0.113.7", limit: 10, maxInFlight: 4 },
    ]);
    expect(strikeKeys(identity, undefined, LIMITS).map((key) => key.id)).toEqual(["session:s-1", "user:biff"]);
  });
});

describe("strikeLimits", () => {
  it("defaults to 3 strikes in 15 minutes (10 and 4 quotes in flight for an address), a 15-minute block, 6 hours of memory", () => {
    expect(strikeLimits()).toEqual({
      limit: 3,
      ipLimit: 10,
      ipMaxInFlight: 4,
      windowMs: 900_000,
      blockMs: 900_000,
      refusalMs: 21_600_000,
    });
  });

  it("reads the environment, and keeps the default for a value that is not a positive integer", () => {
    vi.stubEnv("STRIKE_LIMIT", "5");
    vi.stubEnv("IP_STRIKE_LIMIT", "20");
    vi.stubEnv("IP_MAX_IN_FLIGHT", "0");
    vi.stubEnv("STRIKE_WINDOW_S", "60");
    vi.stubEnv("STRIKE_BLOCK_S", "-1");
    vi.stubEnv("REFUSAL_MEMORY_S", "soon");

    expect(strikeLimits()).toEqual({
      limit: 5,
      ipLimit: 20,
      ipMaxInFlight: 4,
      windowMs: 60_000,
      blockMs: 900_000,
      refusalMs: 21_600_000,
    });
  });
});
