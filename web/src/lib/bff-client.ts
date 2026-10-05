import { isProblem, type Problem, type ProblemCode, type Quote } from "@/lib/contract";

/** What the browser gets from the BFF: the payload, or a problem to explain. */
export type BffResult<T> = { ok: true; data: T } | { ok: false; problem: Problem };

/**
 * Asks for a quote. A body over `maxBodyBytes` (what the BFF reads, passed down by the page) is not
 * sent: a proxy in front would cut it with a page of its own, and the visitor can be told at once.
 */
export function requestQuote(cart: string, quoter: string, maxBodyBytes?: number): Promise<BffResult<Quote>> {
  const body = JSON.stringify({ cart, quoter });
  if (maxBodyBytes !== undefined && new TextEncoder().encode(body).length > maxBodyBytes) {
    return Promise.resolve({ ok: false, problem: localProblem("payload_too_large", 413) });
  }
  return callBff("/api/quotes", { method: "POST", headers: { "Content-Type": "application/json" }, body });
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
  if (isProblem(body)) return { ok: false, problem: body };
  // A 413 that is not ours (a proxy's own page, HTML) is the same refusal as ours.
  if (response.status === 413) return { ok: false, problem: localProblem("payload_too_large", 413) };
  return { ok: false, problem: localProblem("internal", response.status) };
}

function localProblem(code: ProblemCode, status: number): Problem {
  return { type: "about:blank", title: code, status, code };
}
