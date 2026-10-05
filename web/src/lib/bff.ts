import "server-only";

import { type Quoter, quoterClient, quoterTimeoutMs } from "@/lib/quoter";
import { isProblem, type Problem, type ProblemCode } from "@/lib/contract";

type QuoterClient = ReturnType<typeof quoterClient>;

interface QuoterAnswer {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Calls a quoter and relays its answer as is: same status, same JSON (a
 * payload or a Problem). A quoter that cannot be reached, answers after
 * `QUOTER_TIMEOUT_MS` or out of contract becomes `502 quoter_unavailable`.
 */
export async function relay(
  quoter: Quoter,
  requestId: string,
  call: (client: QuoterClient, signal: AbortSignal) => Promise<QuoterAnswer>,
): Promise<Response> {
  const headers = { "X-Request-Id": requestId };
  try {
    const { data, error, response } = await call(quoterClient(quoter), AbortSignal.timeout(quoterTimeoutMs()));
    if (data !== undefined) return Response.json(data, { status: response.status, headers });
    if (isProblem(error)) {
      return Response.json(error, {
        status: response.status,
        headers: { ...headers, "Content-Type": "application/problem+json" },
      });
    }
    throw new Error(`answer out of contract (HTTP ${response.status})`);
  } catch (error) {
    console.error(`[${requestId}] quoter "${quoter.name}" unavailable:`, error);
    return problemResponse(502, "quoter_unavailable", `The "${quoter.name}" quoter did not answer.`, requestId);
  }
}

const TITLES: Partial<Record<ProblemCode, string>> = {
  malformed_request: "Malformed request",
  too_many_refusals: "Too many refusals",
  quote_in_progress: "Quote in progress",
  daily_budget_exhausted: "Daily budget exhausted",
  payload_too_large: "Payload too large",
  rate_limited: "Too many requests",
  ip_budget_exhausted: "Address budget exhausted",
  quoter_unavailable: "Quoter unavailable",
};

/** A problem raised by the BFF itself, shaped like the quoter's; `extensions` adds its facts. */
export function problemResponse(
  status: number,
  code: ProblemCode,
  detail: string,
  requestId: string,
  extensions: Pick<Problem, "retry_after_s"> = {},
): Response {
  return problemJson(
    { type: `/problems/${code}`, title: TITLES[code] ?? code, status, code, detail, request_id: requestId, ...extensions },
    requestId,
  );
}

/** A problem as an answer: its status, `application/problem+json`, and `Retry-After` when it says when. */
export function problemJson(problem: Problem, requestId: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/problem+json", "X-Request-Id": requestId };
  if (problem.retry_after_s !== undefined) headers["Retry-After"] = String(problem.retry_after_s);
  return Response.json(problem, { status: problem.status, headers });
}
