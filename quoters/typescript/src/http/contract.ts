import type { components } from '../generated/openapi.ts';
import type { Engines } from '../pipeline/ports.ts';
import type { Quote as PipelineQuote } from '../pipeline/pipeline.ts';
import type { GuardVerdict, Judgement, Rejection, Report } from '../pipeline/rejection.ts';

/**
 * The pipeline's values in the contract's words (api/openapi.yaml, whose
 * types are generated into src/generated). Nothing is decided here.
 */

type Schemas = components['schemas'];
export type Quote = Schemas['Quote'];
export type Problem = Schemas['Problem'];
export type ProblemCode = Schemas['ProblemCode'];
export type Health = Schemas['Health'];
export type Catalog = Schemas['Catalog'];
export type Usage = Schemas['Usage'];

/** What every answer about a reading says of where it ran. */
export interface Context {
  engines: Engines['name'];
  judgeThreshold: number;
  /** The request's trace, when traces are exported. */
  traceId?: string;
}

const TITLES: Record<ProblemCode, string> = {
  malformed_request: 'Malformed request',
  payload_too_large: 'Payload too large',
  empty_cart: 'Cart rejected',
  too_long: 'Cart rejected',
  injection: 'Cart rejected',
  invalid_request: 'Cart rejected',
  no_film: 'Cart rejected',
  quantity_too_large: 'Cart rejected',
  unfaithful_reading: 'Cart rejected',
  engine_unavailable: 'Engine unavailable',
  quantity_unverified: 'Quantities not verified',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  internal: 'Internal error',
};

export function problem(status: number, code: ProblemCode, detail: string): Problem {
  return { type: `/problems/${code}`, title: TITLES[code], status, code, detail };
}

/** The problem of a cart a stage refused, with the facts that decided and what the reading cost. */
export function rejected(rejection: Rejection, context: Context): Problem {
  const { tokens, guard, copies, judgement } = rejection.facts;
  // nothing is wrong with the cart when its quantities could not be verified: the same one may be priced on a retry
  const status = rejection.code === 'quantity_unverified' ? 503 : 422;
  return {
    ...problem(status, rejection.code, rejection.detail),
    ...(tokens && { tokens }),
    ...(guard && { guard: guardOutcome(guard) }),
    ...(copies && { quantity: copies }),
    ...(judgement && { judge: judgeOutcome(judgement, context) }),
    usage: usage(rejection.report, context),
  };
}

export function quote(q: PipelineQuote, context: Context): Quote {
  const { lines, subtotalCents, discount, totalCents } = q.price;
  return {
    id: q.id,
    currency: 'EUR',
    lines: lines.map((l) => ({
      title: l.title,
      quantity: l.quantity,
      film: l.film,
      confidence: l.confidence,
      unit_price_cents: l.unitCents,
      subtotal_cents: l.subtotalCents,
    })),
    subtotal_cents: subtotalCents,
    discount: {
      distinct_volumes: discount.distinctVolumes,
      percent: discount.percent as Quote['discount']['percent'],
      base_cents: discount.baseCents,
      amount_cents: discount.amountCents,
    },
    total_cents: totalCents,
    judge: judgeOutcome(q.judgement, context),
    usage: usage(q.report, context),
    created_at: q.createdAt.toISOString(),
  };
}

function guardOutcome(v: GuardVerdict): Schemas['GuardOutcome'] {
  return { verdict: v.verdict, confidence: v.confidence, probabilities: v.probabilities, questions: v.questions };
}

function judgeOutcome(j: Judgement, { judgeThreshold }: Context): Schemas['JudgeOutcome'] {
  return { attempts: j.attempts, score: j.score, threshold: judgeThreshold, checks: j.findings };
}

function usage(r: Report, { engines, traceId }: Context): Usage {
  return {
    implementation: 'typescript',
    engines,
    duration_ms: r.ms,
    cost_usd: r.costUsd,
    ...(traceId !== undefined && { trace_id: traceId }),
    stages: r.stages.map((s) => ({
      stage: s.stage,
      engine: s.engine,
      ...(s.model !== undefined && { model: s.model }),
      calls: s.calls,
      duration_ms: s.ms,
      cost_usd: s.costUsd,
      ...(s.stage === 'prepare' && { tokens: s.tokens ?? 0 }),
      ...(s.degraded === true && { degraded: true }),
    })),
  };
}
