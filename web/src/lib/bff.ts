import "server-only";

import { type Backend, backendClient, backendTimeoutMs } from "@/lib/backends";
import { isProblem, type Problem, type ProblemCode } from "@/lib/contract";

type BackendClient = ReturnType<typeof backendClient>;

interface BackendAnswer {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Calls a backend and relays its answer as is: same status, same JSON (a
 * payload or a Problem). A backend that cannot be reached, answers after
 * `BACKEND_TIMEOUT_MS` or out of contract becomes `502 backend_unavailable`.
 */
export async function relay(
  backend: Backend,
  requestId: string,
  call: (client: BackendClient, signal: AbortSignal) => Promise<BackendAnswer>,
): Promise<Response> {
  const headers = { "X-Request-Id": requestId };
  try {
    const { data, error, response } = await call(backendClient(backend), AbortSignal.timeout(backendTimeoutMs()));
    if (data !== undefined) return Response.json(data, { status: response.status, headers });
    if (isProblem(error)) {
      return Response.json(error, {
        status: response.status,
        headers: { ...headers, "Content-Type": "application/problem+json" },
      });
    }
    throw new Error(`answer out of contract (HTTP ${response.status})`);
  } catch (error) {
    console.error(`[${requestId}] backend "${backend.name}" unavailable:`, error);
    return problemResponse(502, "backend_unavailable", `The "${backend.name}" backend did not answer.`, requestId);
  }
}

const TITLES: Partial<Record<ProblemCode, string>> = {
  malformed_request: "Malformed request",
  no_session: "No session",
  backend_unavailable: "Backend unavailable",
};

/** A problem raised by the BFF itself, shaped like the backend's. */
export function problemResponse(status: number, code: ProblemCode, detail: string, requestId: string): Response {
  const body: Problem = {
    type: `/problems/${code}`,
    title: TITLES[code] ?? code,
    status,
    code,
    detail,
    request_id: requestId,
  };
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/problem+json", "X-Request-Id": requestId },
  });
}
