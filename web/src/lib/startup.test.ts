import { describe, expect, it, vi } from "vitest";

import { refuseToStart, startupProblems } from "./startup";

describe("startupProblems", () => {
  it.each([
    [{ ENGINES: "live" }],
    [{ ENGINES: "live", DAILY_BUDGET_USD: "" }],
    [{ ENGINES: "live", DAILY_BUDGET_USD: "0" }],
    [{ ENGINES: "live", DAILY_BUDGET_USD: "-5" }],
    [{ ENGINES: "live", DAILY_BUDGET_USD: "five" }],
  ])("refuses live engines without a daily budget: %j", (env) => {
    const [problem, ...others] = startupProblems(env);

    expect(others).toEqual([]);
    expect(problem).toContain("ENGINES=live");
    expect(problem).toContain("DAILY_BUDGET_USD");
    expect(problem).toContain("ENGINES=fake");
  });

  it.each([
    [{ ENGINES: "live", DAILY_BUDGET_USD: "5" }],
    [{ ENGINES: "live", DAILY_BUDGET_USD: "0.5" }],
    [{ ENGINES: "fake" }],
    [{ ENGINES: "fake", DAILY_BUDGET_USD: "0" }],
    [{}],
    [{ DAILY_BUDGET_USD: "0" }],
  ])("lets everything else start: %j", (env) => {
    expect(startupProblems(env)).toEqual([]);
  });
});

describe("refuseToStart", () => {
  it("reports the problems in one message that names both variables, and says it refused", () => {
    const fail = vi.fn();

    expect(refuseToStart({ ENGINES: "live" }, fail)).toBe(true);

    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][0]).toMatch(/^delorean web cannot start:\n  ENGINES=live needs DAILY_BUDGET_USD/);
  });

  it("says nothing when it starts", () => {
    const fail = vi.fn();

    expect(refuseToStart({ ENGINES: "live", DAILY_BUDGET_USD: "5" }, fail)).toBe(false);
    expect(fail).not.toHaveBeenCalled();
  });
});
