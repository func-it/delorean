import { isProblem, type Problem, type ProblemCode, type Quote } from "@/lib/contract";

/** What the browser gets from the BFF: the payload, or a problem to explain. */
export type BffResult<T> = { ok: true; data: T } | { ok: false; problem: Problem };

export function requestQuote(cart: string, quoter: string): Promise<BffResult<Quote>> {
  return callBff("/api/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cart, quoter }),
  });
}

async function callBff<T>(path: string, init: RequestInit): Promise<BffResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    // The BFF itself is out of reach (offline, server restarting): same advice as a silent quoter.
    return { ok: false, problem: localProblem("quoter_unavailable", 0) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && body !== null) return { ok: true, data: body as T };
  return { ok: false, problem: isProblem(body) ? body : localProblem("internal", response.status) };
}

function localProblem(code: ProblemCode, status: number): Problem {
  return { type: "about:blank", title: code, status, code };
}
