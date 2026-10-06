import { expect, inject } from 'vitest';
import { api, type Exchange } from '../src/api.ts';
import {
  REJECTED_BY,
  contractViolations,
  mediaType,
  type Problem,
  type ProblemCode,
  type Quote,
} from '../src/contract.ts';
import { quoteViolations, usageViolations } from '../src/invariants.ts';

export const baseUrl = inject('baseUrl');
export const health = inject('health');
export const catalog = inject('catalog');
export const client = api(baseUrl);

/** A cart every engine prices: fake and live alike. */
export const PRICED_CART = 'Back to the Future 1';

/** A priced quote: JSON, per the contract, with the catalog's arithmetic and a coherent usage. */
export function expectQuote({ response, body }: Exchange): Quote {
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(mediaType(response)).toBe('application/json');
  expect(response.headers.get('x-request-id'), 'X-Request-Id').toBeTruthy();
  expect(contractViolations('Quote', body)).toEqual([]);
  const quote = body as Quote;
  expect(quoteViolations(quote, catalog)).toEqual([]);
  expect(usageViolations(quote.usage, health, 'price', quote.judge.attempts)).toEqual([]);
  return quote;
}

/**
 * A problem with this status and code, conforming to the contract. Every
 * answer of an operation carries its X-Request-Id; the router's own 404 and
 * 405 belong to no operation, so `{ router: true }` leaves the header out.
 */
export function expectProblem(exchange: Exchange, status: number, code: ProblemCode, { router = false } = {}): Problem {
  const problem = exchange.body as Problem | undefined;
  expect({ status: exchange.response.status, code: problem?.code }).toEqual({ status, code });
  return expectConformingProblem(exchange, { router });
}

/**
 * Whatever the status: the media type and schema the contract gives it. A
 * 422 carries the usage of the stages that ran, up to the one that refused.
 */
export function expectConforms(exchange: Exchange): void {
  if (exchange.response.status === 200) expectQuote(exchange);
  else expectConformingProblem(exchange);
}

function expectConformingProblem({ response, body }: Exchange, { router = false } = {}): Problem {
  expect(mediaType(response)).toBe('application/problem+json');
  if (!router) expect(response.headers.get('x-request-id'), 'X-Request-Id').toBeTruthy();
  expect(contractViolations('Problem', body)).toEqual([]);
  const problem = body as Problem;
  expect(problem.status, 'problem.status mirrors the HTTP status').toBe(response.status);
  if (problem.request_id !== undefined) expect(problem.request_id).toBe(response.headers.get('x-request-id'));
  const stage = REJECTED_BY[problem.code];
  if (response.status === 422 && stage) {
    expect(problem.usage, 'a 422 carries what the refusal cost').toBeDefined();
    // no_film is said after a second reading (a first one with no film is read once more)
    const readings =
      problem.judge?.attempts ?? (problem.code === 'no_film' ? Math.min(2, catalog.limits.max_reading_attempts) : 1);
    if (problem.usage) expect(usageViolations(problem.usage, health, stage, readings)).toEqual([]);
  }
  if (problem.code === 'quantity_unverified') {
    // refused once the judge held the reading: every stage up to it ran, and not the price
    expect(problem.usage, 'a refusal carries what it cost').toBeDefined();
    if (problem.usage) {
      expect(usageViolations(problem.usage, health, 'judge', problem.judge?.attempts)).toEqual([]);
    }
  }
  if (problem.code === 'unfaithful_reading') {
    // after the last attempt, or earlier when a reading that followed an unfaithful one failed (a model too slow)
    expect(problem.judge?.attempts, 'the refusal says how many readings were judged').toBeGreaterThanOrEqual(1);
    expect(problem.judge?.attempts).toBeLessThanOrEqual(catalog.limits.max_reading_attempts);
  }
  return problem;
}
