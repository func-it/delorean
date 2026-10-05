/**
 * What the app refuses to start with. Pure, so that it can be tested; called
 * by `instrumentation.ts` when the server starts.
 *
 * Live engines cost money on every quote and the BFF is the only public
 * entry: without `DAILY_BUDGET_USD` nothing bounds the spending, so the app
 * does not start. `ENGINES` is what compose tells the web service the quoter
 * run on (`live` or `fake`); absent, nothing is known and nothing is checked.
 */
export function startupProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const budget = Number(env.DAILY_BUDGET_USD);
  if (env.ENGINES === "live" && !(Number.isFinite(budget) && budget > 0)) {
    problems.push(
      "ENGINES=live needs DAILY_BUDGET_USD, a daily spending cap in USD above 0 (for example DAILY_BUDGET_USD=5 in .env); " +
        "or run with ENGINES=fake, which costs nothing.",
    );
  }
  return problems;
}

/**
 * Refuses to start: reports every problem of `startupProblems` through `fail`,
 * which must stop the process. A throw alone does not: the server of the
 * standalone build goes on serving after an instrumentation hook threw.
 */
export function refuseToStart(env: Record<string, string | undefined>, fail: (message: string) => void): boolean {
  const problems = startupProblems(env);
  if (problems.length === 0) return false;
  fail(`delorean web cannot start:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return true;
}
