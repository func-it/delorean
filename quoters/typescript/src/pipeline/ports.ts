import type { Film, Line, Mention } from '../cart.ts';
import type { Report } from './rejection.ts';

/**
 * The ports of the pipeline: each model stage is answered by a live engine
 * (Jev, an LLM, through OpenRouter) or by a deterministic fake in tests. The
 * pipeline owns the order of the stages and every rule that decides; an
 * engine only reads.
 */

/** A step of the reading, as the API contract names it. */
export type Stage = 'prepare' | 'guard' | 'parse' | 'recount' | 'identify' | 'judge' | 'price';

/** What a stage took. Engines report it; the pipeline adds the stage and, unless the engine timed itself, the time. */
export interface EngineUsage {
  /** "jev-1.13", "openai/gpt-6-luna", "fake", "local". */
  engine: string;
  model?: string;
  calls: number;
  ms?: number;
  costUsd: number;
  /** The input tokens the prepare stage counted. */
  tokens?: number;
}

export interface Usage extends EngineUsage {
  stage: Stage;
  ms: number;
  /**
   * The stage failed and the quote went on without it. Only the recount can:
   * it is a second opinion, and the judge is still the guard.
   */
  degraded?: boolean;
}

/** An engine's answer, with what it took. */
export type Answered<T> = T & { usage: EngineUsage };

/** Each call is cancelled with the request: its deadline passed, or its client left. */
export interface Call {
  signal: AbortSignal;
}

/**
 * The guard's two questions, each in a request of its own: `order`, the
 * probability that the message orders films; `steer`, that some of it speaks
 * to the system rather than to the shop. The pipeline makes the verdict.
 */
export interface GuardAnswers {
  order: number;
  steer: number;
}

export interface Guard {
  check(text: string, call: Call): Promise<Answered<GuardAnswers>>;
}

/**
 * Lists the films the customer asks to buy, with their quantities; films
 * mentioned but not bought are left out. The parser's reading is priced; the
 * recount, by another model, only checks its counts.
 *
 * A reading the judge refused is read again: the parser is told what it read
 * and which checks failed (`retry`); the recount never is, so that it stays a
 * second opinion.
 */
export interface Reader {
  read(text: string, call: Call, retry?: Retry): Promise<Answered<{ mentions: Mention[] }>>;
}

/** What a new reading is told: the reading before, and the checks of its judgement that failed, in order. */
export interface Retry {
  previous: readonly Mention[];
  failed: readonly Finding[];
}

/** What one title was identified as. */
export interface Identification {
  film: Film;
  confidence: number;
}

/** Identifies titles, one independent judgement each, answered in the order of the titles. */
export interface Identifier {
  identify(titles: readonly string[], call: Call): Promise<Answered<{ identifications: Identification[] }>>;
}

/** A kind of question the judge puts. */
export type Check = 'asked' | 'identity' | 'missing' | 'count';

/** The answer to one question of the judge, as a score where 1 means faithful. */
export interface Finding {
  check: Check;
  label: string;
  score: number;
}

/**
 * Holds a reading against the text it was read from: `asked` and `identity`
 * for each line, then `missing` for the whole of it. One short question per
 * observable fact, asked on its own. The `count` checks are the pipeline's.
 */
export interface Judge {
  judge(text: string, lines: readonly Line[], call: Call): Promise<Answered<{ findings: Finding[] }>>;
}

/** The engines one pipeline runs on. */
export interface Engines {
  /** "live" or "fake", as the API reports it. */
  name: 'live' | 'fake';
  guard: Guard;
  parser: Reader;
  recounter: Reader;
  identifier: Identifier;
  judge: Judge;
  /** Closes what the engines hold open, their connections; at shutdown. */
  close?(): Promise<void>;
}

/**
 * A model engine failed: unreachable, out of credit, too slow for the
 * request, or answering outside its contract. The API answers
 * 502 engine_unavailable; the cause is logged, never shown.
 */
export class EngineError extends Error {
  override name = 'EngineError';
  /** What the engine took before it failed, when it knows. */
  readonly usage: EngineUsage | undefined;
  /** What the whole reading took up to the failure, set by the pipeline. */
  report: Report | undefined;

  constructor(message: string, options?: ErrorOptions & { usage?: EngineUsage }) {
    super(message, options);
    this.usage = options?.usage;
  }
}

/** `error`, an engine's failure, as an EngineError that says what the engine took. */
export function engineFailure(error: unknown, usage: EngineUsage): EngineError {
  const message = error instanceof Error ? error.message : String(error);
  return new EngineError(message, { cause: error instanceof EngineError ? (error.cause ?? error) : error, usage });
}

/**
 * Whether `signal` was aborted by a cancellation (the client gone, or a
 * sibling call's failure) rather than by the request's deadline. A cancelled
 * call is not traced as an error; one past the deadline is.
 */
export function isCancelled(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason: unknown = signal.reason;
  return !(reason instanceof DOMException && reason.name === 'TimeoutError');
}
