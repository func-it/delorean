import { maxBodyBytes, readBodyText } from "@/lib/body";
import {
  budgetStore,
  dailyBudgetUsd,
  ipBudgetStore,
  ipDailyBudgetUsd,
  secondsUntilUtcMidnight,
  unansweredQuoteCostUsd,
} from "@/lib/budget";
import { rateLimit, rateLimiter } from "@/lib/rate";
import { resolveQuoter } from "@/lib/quoters";
import { problemJson, problemResponse, relay } from "@/lib/bff";
import { clientIp } from "@/lib/client-ip";
import { isProblem, type Problem } from "@/lib/contract";
import { ensureSession, type Session } from "@/lib/session";
import { type StrikeKey, refusalKey, strikeKeys, strikeLimits, type StrikeStore, strikeStore } from "@/lib/strikes";

/** The key of a request from no known address: they all share it. */
const UNKNOWN_ADDRESS = "unknown";

interface QuoteBody {
  cart: string;
  /** A configured quoter name; the default quoter when absent. */
  quoter?: string;
}

/**
 * Prices a cart: forwards `{ cart }` to the quoter's `POST /v1/quotes` with
 * the session identity (an anonymous session is started when the visitor has none), and relays the answer (a Quote, or a Problem the UI
 * explains).
 *
 * First, the rate per client address (lib/rate.ts): over `IP_RATE_LIMIT`
 * quotes within `IP_RATE_WINDOW_S`, `429 rate_limited`, before anything else
 * is done or read.
 *
 * The strike rule (lib/strikes.ts) comes next: a session or a username with
 * a quote in flight, or an address with `IP_MAX_IN_FLIGHT` of them, gets
 * `429 quote_in_progress`; a blocked key gets
 * `429 too_many_refusals`, and a text refused as an injection before gets the
 * same refusal again; none of them reaches the quoter. Never a retry of the
 * guard on our side either: each draw of a probabilistic classifier is one
 * more chance to slip past it. The body is read up to `MAX_BODY_BYTES`, no
 * further (`413 payload_too_large`).
 *
 * Then the budgets (lib/budget.ts), before the quoter is called: the client
 * address's share, `IP_DAILY_BUDGET_USD` (`429 ip_budget_exhausted`), and the
 * day's, `DAILY_BUDGET_USD` (`503 daily_budget_exhausted`), both over the UTC
 * day. What every relayed answer cost (`usage.cost_usd`, or an estimate for
 * a quoter that said nothing) is added to both.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const address = clientIp(request.headers);
  const wait = await rateLimiter().hit(address ?? UNKNOWN_ADDRESS, rateLimit());
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    return problemResponse(
      429,
      "rate_limited",
      `Too many quotes from this address: try again in ${seconds} s.`,
      requestId,
      { retry_after_s: seconds },
    );
  }

  const session = await ensureSession();

  const strikes = strikeStore();
  const keys = strikeKeys(session, address, strikeLimits());
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
    return await quote(request, requestId, session, address, strikes, keys);
  } finally {
    await strikes.release(keys);
  }
}

/** Under the keys' lease: the block is checked here, so that no strike lands between the check and the call. */
async function quote(
  request: Request,
  requestId: string,
  session: Session,
  address: string | undefined,
  strikes: StrikeStore,
  keys: StrikeKey[],
) {
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

  const read = await readBody(request);
  if (read === "too_large") {
    return problemResponse(413, "payload_too_large", "The request body is too large.", requestId);
  }
  if (!read) {
    return problemResponse(400, "malformed_request", 'Expected a JSON body {"cart": string, "quoter"?: string}.', requestId);
  }
  const body = read;

  const quoter = resolveQuoter(body.quoter);
  if (!quoter) return problemResponse(400, "malformed_request", `Unknown quoter "${body.quoter}".`, requestId);

  const memory = refusalKey(address, session.sessionId, body.cart);
  const remembered = await strikes.recall(memory);
  if (remembered) {
    await strikes.strike(keys);
    return problemJson({ ...remembered, request_id: requestId, remembered: true }, requestId);
  }

  const addressKey = address ?? UNKNOWN_ADDRESS;
  const ipBudget = ipDailyBudgetUsd();
  if (ipBudget > 0 && (await ipBudgetStore().spentToday(addressKey)) >= ipBudget) {
    return problemResponse(
      429,
      "ip_budget_exhausted",
      "This address has used its share of the daily budget: try again after midnight UTC.",
      requestId,
      { retry_after_s: secondsUntilUtcMidnight(Date.now()) },
    );
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

  if (budget > 0 || ipBudget > 0) {
    const cost = await costOf(response);
    if (budget > 0) await budgetStore().add(cost);
    if (ipBudget > 0) await ipBudgetStore().add(addressKey, cost);
  }

  const refusal = await injectionRefusal(response);
  if (refusal) {
    await strikes.strike(keys);
    await strikes.remember(memory, refusal);
  }
  return response;
}

/**
 * What a relayed answer cost: its `usage.cost_usd`, on a Quote, a refusal or
 * a failure alike (the quoters put the usage of the stages that ran on a 502
 * and a 500 too). An answer that says nothing of it and is a failure (the
 * quoter did not answer, or failed without a usage) counts for the flat
 * estimate of `unansweredQuoteCostUsd`: it may have spent. Anything else
 * without a usage costs nothing.
 */
async function costOf(response: Response): Promise<number> {
  const answer: unknown = await response.clone().json().catch(() => null);
  const usage = typeof answer === "object" && answer !== null ? (answer as { usage?: { cost_usd?: unknown } }).usage : undefined;
  const cost = usage?.cost_usd;
  if (typeof cost === "number") return cost;
  return response.status >= 500 ? unansweredQuoteCostUsd() : 0;
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

/** The body as `{cart, quoter?}`: `null` when malformed, `"too_large"` when over `MAX_BODY_BYTES` (never read past it). */
async function readBody(request: Request): Promise<QuoteBody | null | "too_large"> {
  const text = await readBodyText(request, maxBodyBytes());
  if (!text.ok) return "too_large";
  let body: unknown;
  try {
    body = JSON.parse(text.text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { cart, quoter } = body as Record<string, unknown>;
  if (typeof cart !== "string") return null;
  if (quoter !== undefined && typeof quoter !== "string") return null;
  return { cart, quoter };
}
