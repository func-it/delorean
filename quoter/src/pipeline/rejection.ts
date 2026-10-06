import type { Finding, Usage } from './ports.ts';

/** Which stage refused a cart, and why: the API's problem codes. */
export type RejectionCode =
  | 'empty_cart' // prepare
  | 'too_long' // prepare
  | 'injection' // guard
  | 'invalid_request' // guard
  | 'no_film' // parse
  | 'quantity_too_large' // parse
  | 'demo_unreadable' // parse: only the fake engines, a line they cannot read safely
  | 'unfaithful_reading' // judge
  | 'quantity_unverified' // price: no recount to count the quantities against; retryable
  | 'repeated_titles'; // price: the same, on a cart that repeats a title on many lines: group them

export type Verdict = 'valid' | 'injection' | 'invalid';

/** The guard's verdict, made of its two answers. */
export interface GuardVerdict {
  verdict: Verdict;
  /** The verdict's probability. */
  confidence: number;
  probabilities: Record<Verdict, number>;
  questions: { order: number; steer: number };
}

/** The judge's view of a reading: every finding, and the worst score, which decides. */
export interface Judgement {
  score: number;
  findings: Finding[];
  /** How many readings were made before this judgement, this one included. */
  attempts: number;
}

/** What a reading took: each stage that ran, in order, and the totals. */
export interface Report {
  stages: Usage[];
  ms: number;
  costUsd: number;
  /** The readings made; undefined when the cart was refused before any. */
  attempts?: number;
}

/** The facts behind a refusal: `tokens` for too_long, `guard` for the guard's, `copies` for quantity_too_large, `judgement` for unfaithful_reading. */
export interface RejectionFacts {
  tokens?: { count: number; max: number };
  guard?: GuardVerdict;
  copies?: { title: string; count: number; max: number };
  judgement?: Judgement;
}

/** A cart a stage refused to price: the facts that decided, and what the reading took up to there. */
export class Rejection extends Error {
  override name = 'Rejection';
  readonly code: RejectionCode;
  /** Why, in a sentence for the customer. */
  readonly detail: string;
  readonly facts: RejectionFacts;
  report: Report = { stages: [], ms: 0, costUsd: 0 };

  /** `cause`: what went wrong behind it, for the log and the trace, never shown: the engine failure of a re-reading. */
  constructor(code: RejectionCode, detail: string, facts: RejectionFacts = {}, cause?: unknown) {
    super(`cart rejected: ${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.code = code;
    this.detail = detail;
    this.facts = facts;
  }
}
