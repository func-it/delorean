import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dailyBudgetUsd, FileBudgetStore, secondsUntilUtcMidnight, utcDay } from "./budget";

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
