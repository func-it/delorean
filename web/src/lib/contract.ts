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
 * backend contract, plus two the BFF raises itself.
 *
 * - `no_session` (401): no valid session cookie; log in again.
 * - `backend_unavailable` (502): the backend could not be reached, did not
 *   answer within `BACKEND_TIMEOUT_MS`, or answered out of contract.
 */
export type ProblemCode = Schemas["ProblemCode"] | "no_session" | "backend_unavailable";

/** An RFC 9457 problem as the BFF returns it (`application/problem+json`). */
export type Problem = Omit<Schemas["Problem"], "code"> & { code: ProblemCode };

export function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const { code, status } = value as Record<string, unknown>;
  return typeof code === "string" && typeof status === "number";
}
