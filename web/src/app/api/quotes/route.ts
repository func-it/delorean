import { budgetStore, dailyBudgetUsd, secondsUntilUtcMidnight } from "@/lib/budget";
import { resolveQuoter } from "@/lib/quoters";
import { problemJson, problemResponse, relay } from "@/lib/bff";
import { clientIp } from "@/lib/client-ip";
import { isProblem, type Problem } from "@/lib/contract";
import { getSession, type Session } from "@/lib/session";
import { cartDigest, type StrikeKey, strikeKeys, strikeLimits, type StrikeStore, strikeStore } from "@/lib/strikes";

interface QuoteBody {
  cart: string;
  /** A configured quoter name; the default quoter when absent. */
  quoter?: string;
}

/**
 * Prices a cart: forwards `{ cart }` to the quoter's `POST /v1/quotes` with
 * the session identity, and relays the answer (a Quote, or a Problem the UI
 * explains).
 *
 * The strike rule (lib/strikes.ts) comes first: a session or a username with
 * a quote in flight, or an address with `IP_MAX_IN_FLIGHT` of them, gets
 * `429 quote_in_progress`; a blocked key gets
 * `429 too_many_refusals`, and a text refused as an injection before gets the
 * same refusal again; none of them reaches the quoter. Never a retry of the
 * guard on our side either: each draw of a probabilistic classifier is one
 * more chance to slip past it.
 *
 * Then the daily budget (lib/budget.ts): once `DAILY_BUDGET_USD` is spent
 * (UTC day), `503 daily_budget_exhausted` before the quoter is called. What
 * every relayed answer cost (`usage.cost_usd`) is added to the day's total.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const session = await getSession();
  if (!session) return problemResponse(401, "no_session", "Log in before pricing a cart.", requestId);

  const strikes = strikeStore();
  const keys = strikeKeys(session, clientIp(request.headers), strikeLimits());
  if (!(await strikes.acquire(keys))) {
    return problemResponse(
      429,
      "quote_in_progress",
      "Quotes are already in progress for this session, username or address.",
      requestId,
      { retry_after_s: 1 },
    );
  }
  try {
    return await quote(request, requestId, session, strikes, keys);
  } finally {
    await strikes.release(keys);
  }
}

/** Under the keys' lease: the block is checked here, so that no strike lands between the check and the call. */
async function quote(request: Request, requestId: string, session: Session, strikes: StrikeStore, keys: StrikeKey[]) {
  const blockedMs = await strikes.blockedFor(keys);
  if (blockedMs > 0) {
    const seconds = Math.ceil(blockedMs / 1000);
    return problemResponse(
      429,
      "too_many_refusals",
      `Too many carts refused as injections: try again in ${seconds} s.`,
      requestId,
      { retry_after_s: seconds },
    );
  }

  const body = await readBody(request);
  if (!body) {
    return problemResponse(400, "malformed_request", 'Expected a JSON body {"cart": string, "quoter"?: string}.', requestId);
  }

  const quoter = resolveQuoter(body.quoter);
  if (!quoter) return problemResponse(400, "malformed_request", `Unknown quoter "${body.quoter}".`, requestId);

  const digest = cartDigest(body.cart);
  const remembered = await strikes.recall(digest);
  if (remembered) {
    await strikes.strike(keys);
    return problemJson({ ...remembered, request_id: requestId, remembered: true }, requestId);
  }

  const budget = dailyBudgetUsd();
  if (budget > 0 && (await budgetStore().spentToday()) >= budget) {
    return problemResponse(
      503,
      "daily_budget_exhausted",
      "The daily spending budget is exhausted: try again after midnight UTC.",
      requestId,
      { retry_after_s: secondsUntilUtcMidnight(Date.now()) },
    );
  }

  const response = await relay(quoter, requestId, (client, signal) =>
    client.POST("/v1/quotes", {
      body: { cart: body.cart },
      params: {
        header: { "X-User-Id": session.username, "X-Session-Id": session.sessionId, "X-Request-Id": requestId },
      },
      signal,
    }),
  );

  if (budget > 0) await budgetStore().add(await costOf(response));

  const refusal = await injectionRefusal(response);
  if (refusal) {
    await strikes.strike(keys);
    await strikes.remember(digest, refusal);
  }
  return response;
}

/** `usage.cost_usd` of a relayed Quote or Problem; 0 for what carries none (a BFF problem, a quoter that was down). */
async function costOf(response: Response): Promise<number> {
  const answer: unknown = await response.clone().json().catch(() => null);
  const usage = typeof answer === "object" && answer !== null ? (answer as { usage?: { cost_usd?: unknown } }).usage : undefined;
  const cost = usage?.cost_usd;
  return typeof cost === "number" ? cost : 0;
}

/**
 * The problem of a `422 injection`, as it will be repeated: without its
 * request id and its usage, which belong to this call only.
 */
async function injectionRefusal(response: Response): Promise<Problem | undefined> {
  if (response.status !== 422) return undefined;
  const problem: unknown = await response.clone().json().catch(() => null);
  if (!isProblem(problem) || problem.code !== "injection") return undefined;
  const refusal = { ...problem };
  delete refusal.request_id;
  delete refusal.usage;
  return refusal;
}

async function readBody(request: Request): Promise<QuoteBody | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const { cart, quoter } = body as Record<string, unknown>;
  if (typeof cart !== "string") return null;
  if (quoter !== undefined && typeof quoter !== "string") return null;
  return { cart, quoter };
}
