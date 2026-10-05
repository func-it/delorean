import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dailyBudgetUsd,
  FileBudgetStore,
  ipDailyBudgetUsd,
  MemoryIpBudgetStore,
  secondsUntilUtcMidnight,
  unansweredQuoteCostUsd,
  utcDay,
} from "./budget";

const MORNING = Date.parse("2026-10-04T08:00:00Z");
const LAST_SECOND = Date.parse("2026-10-04T23:59:59Z");
const NEXT_DAY = Date.parse("2026-10-05T00:00:00Z");

describe("FileBudgetStore", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "budget-"));
    file = join(directory, "nested", "budget.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("starts at zero without a file", async () => {
    expect(await new FileBudgetStore(file, () => MORNING).spentToday()).toBe(0);
  });

  it("adds the costs of the day, without float drift, and writes them", async () => {
    const store = new FileBudgetStore(file, () => MORNING);
    for (let i = 0; i < 10; i++) await store.add(0.1);
    await store.add(0.00213);

    expect(await store.spentToday()).toBe(1.00213);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ day: "2026-10-04", spent_usd: 1.00213 });
  });

  it("ignores what is not a cost", async () => {
    const store = new FileBudgetStore(file, () => MORNING);
    for (const cost of [0, -1, NaN, Infinity]) await store.add(cost);

    expect(await store.spentToday()).toBe(0);
  });

  it("loses no update when answers arrive together", async () => {
    const store = new FileBudgetStore(file, () => MORNING);
    await Promise.all(Array.from({ length: 50 }, () => store.add(0.01)));

    expect(await store.spentToday()).toBe(0.5);
  });

  it("keeps the total across a restart", async () => {
    await new FileBudgetStore(file, () => MORNING).add(0.75);

    const restarted = new FileBudgetStore(file, () => LAST_SECOND);
    expect(await restarted.spentToday()).toBe(0.75);
    await restarted.add(0.25);
    expect(await new FileBudgetStore(file, () => LAST_SECOND).spentToday()).toBe(1);
  });

  it("starts a new total at midnight UTC", async () => {
    let now = LAST_SECOND;
    const store = new FileBudgetStore(file, () => now);
    await store.add(2);
    expect(await store.spentToday()).toBe(2);

    now = NEXT_DAY;
    expect(await store.spentToday()).toBe(0);
    await store.add(0.5);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ day: "2026-10-05", spent_usd: 0.5 });
  });

  it("starts a new total when the container restarts the next day", async () => {
    await new FileBudgetStore(file, () => LAST_SECOND).add(2);

    expect(await new FileBudgetStore(file, () => NEXT_DAY).spentToday()).toBe(0);
  });

  it("leaves no temporary file behind", async () => {
    await new FileBudgetStore(file, () => MORNING).add(1);

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(directory, "nested"))).toEqual(["budget.json"]);
  });

  it("counts from zero, and says so, when the file is corrupt", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(file.replace("nested/", ""), "{not json");

    expect(await new FileBudgetStore(file.replace("nested/", ""), () => MORNING).spentToday()).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it("keeps counting in memory when the file cannot be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // the parent "directory" is a regular file: mkdir fails
    await writeFile(join(directory, "blocker"), "");
    const store = new FileBudgetStore(join(directory, "blocker", "budget.json"), () => MORNING);

    await store.add(1);

    expect(await store.spentToday()).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});

describe("UTC day helpers", () => {
  it("names the UTC day", () => {
    expect(utcDay(Date.parse("2026-10-04T23:59:59-05:00"))).toBe("2026-10-05");
  });

  it.each([
    [Date.parse("2026-10-04T00:00:00Z"), 86_400],
    [Date.parse("2026-10-04T23:00:00Z"), 3_600],
    [Date.parse("2026-10-04T23:59:59.500Z"), 1],
  ])("counts the seconds until midnight UTC from %s", (now, seconds) => {
    expect(secondsUntilUtcMidnight(now)).toBe(seconds);
  });
});

describe("dailyBudgetUsd", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["-3", 0],
    ["abc", 0],
    ["5", 5],
    ["2.5", 2.5],
  ])("reads %s as %s", (value, expected) => {
    if (value === undefined) vi.stubEnv("DAILY_BUDGET_USD", undefined as unknown as string);
    else vi.stubEnv("DAILY_BUDGET_USD", value);
    expect(dailyBudgetUsd()).toBe(expected);
  });
});

describe("MemoryIpBudgetStore", () => {
  it("adds what an address spent today, in millionths, and starts again at midnight UTC", async () => {
    let now = LAST_SECOND;
    const store = new MemoryIpBudgetStore(() => now);
    for (let i = 0; i < 10; i++) await store.add("203.0.113.7", 0.1);

    expect(await store.spentToday("203.0.113.7")).toBe(1);
    expect(await store.spentToday("198.51.100.9")).toBe(0);

    now = NEXT_DAY;
    expect(await store.spentToday("203.0.113.7")).toBe(0);
    await store.add("203.0.113.7", 0.5);
    expect(await store.spentToday("203.0.113.7")).toBe(0.5);
  });

  it("ignores what is not a cost", async () => {
    const store = new MemoryIpBudgetStore(() => MORNING);
    for (const cost of [0, -1, NaN, Infinity]) await store.add("a", cost);

    expect(await store.spentToday("a")).toBe(0);
  });

  it("holds a bounded number of addresses, the least recently used going first", async () => {
    const store = new MemoryIpBudgetStore(() => MORNING, 2);
    await store.add("a", 1);
    await store.add("b", 1);
    await store.add("a", 1); // a is used again: b is the oldest
    await store.add("c", 1);

    expect(await store.spentToday("b")).toBe(0);
    expect(await store.spentToday("a")).toBe(2);
    expect(await store.spentToday("c")).toBe(1);
  });
});

describe("ipDailyBudgetUsd", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["8", undefined, 2], // a quarter of the day's budget
    ["8", "", 2],
    ["8", "0", 0], // off
    ["8", "3", 3],
    ["8", "-1", 2],
    ["8", "lots", 2],
    [undefined, undefined, 0], // no budget, no share
    ["0", undefined, 0],
    [undefined, "3", 3], // an explicit cap stands alone
  ])("with DAILY_BUDGET_USD=%s and IP_DAILY_BUDGET_USD=%s, an address has %s", (daily, ip, expected) => {
    vi.stubEnv("DAILY_BUDGET_USD", daily as string);
    vi.stubEnv("IP_DAILY_BUDGET_USD", ip as string);
    expect(ipDailyBudgetUsd()).toBe(expected);
  });
});

describe("unansweredQuoteCostUsd", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, 0.002],
    ["", 0.002],
    ["0", 0],
    ["0.01", 0.01],
    ["-1", 0.002],
    ["lots", 0.002],
  ])("reads %s as %s", (value, expected) => {
    vi.stubEnv("UNANSWERED_QUOTE_COST_USD", value as string);
    expect(unansweredQuoteCostUsd()).toBe(expected);
  });
});
