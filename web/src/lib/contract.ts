import type { components } from "@/generated/api";

type Schemas = components["schemas"];

export type Catalog = Schemas["Catalog"];
export type Quote = Schemas["Quote"];
export type QuoteLine = Schemas["QuoteLine"];
export type Discount = Schemas["Discount"];
export type Film = Schemas["Film"];
export type JudgeOutcome = Schemas["JudgeOutcome"];
export type JudgeCheck = Schemas["JudgeCheck"];
export type GuardOutcome = Schemas["GuardOutcome"];
export type Usage = Schemas["Usage"];

/**
 * Problem codes the browser can receive from the BFF: every code of the
 * quoter contract, plus the ones the BFF raises itself.
 *
 * - `too_many_refusals` (429): the session, the username or the client
 *   address had `STRIKE_LIMIT` carts refused as injections within
 *   `STRIKE_WINDOW_S`; it is blocked for `retry_after_s` more seconds.
 * - `quote_in_progress` (429): a quote is already in flight for the session,
 *   the username or the client address; one at a time, retry in a second.
 * - `daily_budget_exhausted` (503): the day's spending (UTC) reached
 *   `DAILY_BUDGET_USD`; the quoter was not called, and `retry_after_s` is the
 *   time left until midnight UTC.
 * - `rate_limited` (429): the client address sent more than `IP_RATE_LIMIT`
 *   quotes within `IP_RATE_WINDOW_S`; `retry_after_s` is the wait.
 * - `ip_budget_exhausted` (429): what the client address's quotes cost today
 *   (UTC) reached its share of the budget, `IP_DAILY_BUDGET_USD`;
 *   `retry_after_s` is the time left until midnight UTC.
 * - `quoter_unavailable` (502): the quoter could not be reached, did not
 *   answer within `QUOTER_TIMEOUT_MS`, or answered out of contract.
 */
export type ProblemCode =
  | Schemas["ProblemCode"]
  | "too_many_refusals"
  | "quote_in_progress"
  | "daily_budget_exhausted"
  | "rate_limited"
  | "ip_budget_exhausted"
  | "quoter_unavailable";

/**
 * An RFC 9457 problem as the BFF returns it (`application/problem+json`), with
 * two extensions of the BFF's:
 *
 * - `retry_after_s` (`too_many_refusals`, `quote_in_progress`, `rate_limited`, `ip_budget_exhausted`,
 *   `daily_budget_exhausted`): seconds
 *   before trying again, also in the `Retry-After` header;
 * - `remembered` (`injection`): this text was refused before, and the refusal
 *   is repeated without asking the quoter again.
 */
export type Problem = Omit<Schemas["Problem"], "code"> & {
  code: ProblemCode;
  retry_after_s?: number;
  remembered?: boolean;
};

export function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const { code, status } = value as Record<string, unknown>;
  return typeof code === "string" && typeof status === "number";
}
