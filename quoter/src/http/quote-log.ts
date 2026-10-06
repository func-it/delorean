import type { Report } from '../pipeline/rejection.ts';

/** The most characters of a cart a log line keeps. */
export const MAX_LOGGED_CART = 500;

/**
 * The cart as a log line keeps it: cut to `MAX_LOGGED_CART` characters, by code
 * points so that an emoji or any other character outside the BMP is never split.
 */
export function loggedCart(text: string): { cart: string; cart_truncated?: true } {
  const points = Array.from(text);
  if (points.length <= MAX_LOGGED_CART) return { cart: text };
  return { cart: points.slice(0, MAX_LOGGED_CART).join(''), cart_truncated: true };
}

/** What a quote adds to its request's log line: how it ended and what it took, the customer's text only when `cart` is given. */
export function quoteFields(
  answered: { outcome: string; totalCents?: number; report: Report | undefined },
  cart?: string,
): Record<string, unknown> {
  const { outcome, totalCents, report } = answered;
  const stages: Record<string, number> = {};
  for (const s of report?.stages ?? []) stages[s.stage] = (stages[s.stage] ?? 0) + s.ms;
  return {
    ...(cart !== undefined && loggedCart(cart)),
    outcome,
    total_cents: totalCents ?? null,
    readings: report?.attempts ?? null,
    cost_usd: report?.costUsd ?? null,
    stage_ms: report ? stages : null,
  };
}
