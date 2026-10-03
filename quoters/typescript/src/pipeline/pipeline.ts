import { randomBytes } from 'node:crypto';
import type { Line, Mention } from '../cart.ts';
import { normalize } from '../prepare/normalize.ts';
import type { TokenCounter } from '../prepare/tokens.ts';
import { price, type Catalog, type Price } from '../pricing.ts';
import { observe, type ObservationType } from '../telemetry/trace.ts';
import {
  EngineError,
  isCancelled,
  type Call,
  type EngineUsage,
  type Engines,
  type Finding,
  type Retry,
  type Stage,
  type Usage,
} from './ports.ts';
import { Identifications, checkFindings, countFindings, merge, readingKey, refusalOf, verdictOf } from './reading.ts';
import { Rejection, type GuardVerdict, type Judgement, type Report } from './rejection.ts';

/**
 * Reads a free-text cart into a priced quote:
 *
 *     prepare → guard → parse   → identify → judge → price
 *                       recount ┘
 *
 * The pipeline owns the order of the stages and every rule that decides;
 * each model stage is a port (ports.ts), answered by a live engine or a fake.
 * The recount reads the cart a second time, on another model, beside the
 * parse; the judge compares the two readings. prepare and price are plain
 * code and never call a model.
 */
export interface PipelineConfig {
  engines: Engines;
  counter: TokenCounter;
  catalog: Catalog;
  /** The most tokens of a cart, counted once normalized. */
  maxInputTokens: number;
  /** The least confidence of a valid verdict. */
  guardMinConfidence: number;
  /** The least worst score of a reading that is priced. */
  judgeThreshold: number;
  /** The most readings of one cart, the first included, before it is refused as unfaithful. */
  readAttempts: number;
}

/** A cart to quote, and who asks, for the trace. */
export interface QuoteRequest {
  cart: string;
  userId?: string;
  sessionId?: string;
}

/** A cart read, held faithful by the judge, and priced. */
export interface Quote {
  id: string;
  price: Price;
  judgement: Judgement;
  report: Report;
  createdAt: Date;
}

/** The pipeline's stages, in order: the order of a report. */
export const STAGES: readonly Stage[] = ['prepare', 'guard', 'parse', 'recount', 'identify', 'judge', 'price'];

/** How Langfuse draws each stage in its graph. */
const OBSERVATION_TYPES: Record<Stage, ObservationType> = {
  prepare: 'span',
  guard: 'guardrail',
  parse: 'chain',
  recount: 'chain',
  identify: 'chain',
  judge: 'evaluator',
  price: 'span',
};

/** The engine of the stages that are plain code. */
const LOCAL: EngineUsage = { engine: 'local', calls: 0, costUsd: 0 };

/** What a stage that failed took, when its engine could not say. */
const UNKNOWN: EngineUsage = { engine: 'unknown', calls: 0, costUsd: 0 };

/** What a stage takes when it has nothing new to ask: no call. */
const NOT_ASKED: EngineUsage = { engine: 'local', calls: 0, costUsd: 0 };

/** A reading and its recount: the parser's mentions as decoded and merged, the recount's merged. */
interface Reading {
  decoded: Mention[];
  read: Mention[];
  recounted: Mention[];
}

export class Pipeline {
  readonly config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * Reads a cart and prices it, its stages traced under the current span
   * (the request's). A cart a stage refuses throws a Rejection, and an
   * engine that fails, answers out of its contract, or has not answered when
   * `signal` aborts, an EngineError: both report what the reading took up to
   * there. Anything else is a bug.
   */
  async quote(request: QuoteRequest, signal: AbortSignal): Promise<Quote> {
    const started = performance.now();
    const run = new Run(signal);
    const report = (): Report => ({ ...run.report(), ms: Math.round(performance.now() - started) });
    try {
      const { price, judgement } = await this.#read(run, request.cart);
      return { id: newQuoteId(), price, judgement, report: report(), createdAt: new Date() };
    } catch (error) {
      const taken = report();
      if (error instanceof Rejection || error instanceof EngineError) error.report = taken;
      else if (typeof error === 'object' && error !== null) bugReports.set(error, taken);
      throw error;
    }
  }

  async #read(run: Run, raw: string): Promise<{ price: Price; judgement: Judgement }> {
    const { engines, counter, maxInputTokens } = this.config;

    const { text, tokens } = await run.stage(
      'prepare',
      () => {
        const text = normalize(raw);
        const tokens = counter.count(text);
        return Promise.resolve({ text, tokens, usage: { ...LOCAL, tokens } });
      },
      (prepared) => prepared,
      { show: ({ tokens }) => ({ tokens }) },
    );
    if (text === '') throw new Rejection('empty_cart', 'The cart is empty.');
    if (tokens > maxInputTokens) {
      throw new Rejection('too_long', `The cart counts ${tokens} tokens, the limit is ${maxInputTokens}.`, {
        tokens: { count: tokens, max: maxInputTokens },
      });
    }

    const verdict = await run.stage(
      'guard',
      (call) => engines.guard.check(text, call),
      (answers) => verdictOf(answers),
    );
    this.#pass(verdict);

    return this.#readUntilFaithful(run, text);
  }

  /**
   * Reads the text, judges the reading, and when the judge refuses it, reads
   * it again, up to `readAttempts` readings in all: the parser told what
   * failed, the recount blind. The first reading that passes is priced;
   * after the last, the cart is refused with the last judgement.
   *
   * Nothing is asked twice in a request: a title is identified once, and a
   * reading already judged (the same titles, quantities and films) is not
   * put to Jev again, only its count checks made anew. A wrong reading Jev
   * refuses two times in three must not get three throws of the dice: a new
   * attempt wins only with a different reading, or a recount that agrees.
   */
  async #readUntilFaithful(run: Run, text: string): Promise<{ price: Price; judgement: Judgement }> {
    const { engines, readAttempts, judgeThreshold } = this.config;
    const identifications = new Identifications();
    const judged = new Map<string, Finding[]>();
    let retry: Retry | undefined;
    let judgement: Judgement | undefined;

    for (let attempt = 1; attempt <= readAttempts; attempt++) {
      const at = run.at(attempt);
      const { decoded, read, recounted } = await this.#readTwice(at, text, retry, attempt === 1);
      if (read.length === 0) {
        // a later reading without film: the text has not changed since the
        // first reading, the model has; a failed attempt, not put to Jev
        judgement = {
          score: 0,
          findings: [{ check: 'missing', label: 'the whole reading', score: 0 }],
          attempts: attempt,
        };
        retry = { previous: decoded, failed: judgement.findings };
        continue;
      }

      // titles already identified in this request are not asked again
      const unknown = identifications.unknown(read, recounted);
      const [lines, recountedLines] = await at.stage(
        'identify',
        (call) =>
          unknown.length > 0
            ? engines.identifier.identify(unknown, call)
            : Promise.resolve({ identifications: [], usage: NOT_ASKED }),
        ({ identifications: answers }) => {
          identifications.learn(unknown, answers);
          return [
            identifications.lines(read, [read, recounted]),
            identifications.lines(recounted, [read, recounted]),
          ] as const;
        },
        { show: ([reading, recount]) => ({ reading, recount }) },
      );

      const known = judged.get(readingKey(lines));
      judgement = await at.stage(
        'judge',
        (call) =>
          known
            ? Promise.resolve({ findings: inLineOrder(known, lines), usage: NOT_ASKED })
            : engines.judge.judge(text, lines, call),
        ({ findings }): Judgement => {
          checkFindings(findings);
          judged.set(readingKey(lines), findings);
          const all = [...findings, ...countFindings(lines, recountedLines)];
          return { score: Math.min(1, ...all.map((f) => f.score)), findings: all, attempts: attempt };
        },
      );
      if (judgement.score >= judgeThreshold) {
        const priced = await run.stage(
          'price',
          () => Promise.resolve({ price: price(this.config.catalog, lines), usage: LOCAL }),
          (answer) => answer.price,
          { show: ({ totalCents }) => ({ total_cents: totalCents }) },
        );
        return { price: priced, judgement };
      }
      // the last reading only, as decoded, and the checks under the threshold, in order
      retry = { previous: decoded, failed: judgement.findings.filter((f) => f.score < judgeThreshold) };
    }

    const last = judgement ?? { score: 0, findings: [], attempts: readAttempts };
    throw new Rejection(
      'unfaithful_reading',
      `The judge does not hold the reading faithful to the text: its worst score, ${last.score.toFixed(2)}, is under ${judgeThreshold.toFixed(2)}.`,
      { judgement: last },
    );
  }

  /**
   * Reads the text with the parser and the recounter side by side; the
   * report has both, the parse first. The parse decides first: its failure,
   * then its refusal, then the recount's failure. Too many copies of a title
   * is refused on any reading, a safety limit; no film only on the first,
   * the first is the one the customer's text answers for. A parse that fails
   * stops the recount, whose reading no longer matters; one that refuses
   * waits for it, and the refusal reports what both took.
   */
  async #readTwice(run: Run, text: string, retry: Retry | undefined, first: boolean): Promise<Reading> {
    const { parser, recounter } = this.config.engines;
    const stopRecount = new AbortController();
    const [parsed, recount] = await Promise.allSettled([
      run
        .stage(
          'parse',
          (call) => parser.read(text, call, retry),
          ({ mentions }) => ({ decoded: mentions, read: merge(mentions) }),
          { show: ({ read }) => read },
        )
        .catch((error: unknown) => {
          stopRecount.abort(error);
          throw error;
        }),
      run.stage(
        'recount',
        (call) => recounter.read(text, call),
        ({ mentions }) => merge(mentions),
        { signal: AbortSignal.any([run.signal, stopRecount.signal]) },
      ),
    ]);
    if (parsed.status === 'rejected') throw parsed.reason;
    const { decoded, read } = parsed.value;
    const refusal = refusalOf(read);
    if (refusal && (first || refusal.code === 'quantity_too_large')) throw refusal;
    if (recount.status === 'rejected') throw recount.reason;
    return { decoded, read, recounted: recount.value };
  }

  /** Lets a valid verdict through when it is confident enough; refuses anything else. */
  #pass(v: GuardVerdict): void {
    const { guardMinConfidence } = this.config;
    if (v.verdict === 'valid' && v.confidence >= guardMinConfidence) return;
    if (v.verdict === 'injection') {
      throw new Rejection('injection', 'The text tries to instruct the system instead of ordering films.', {
        guard: v,
      });
    }
    const detail =
      v.verdict === 'valid'
        ? `The guard is not confident enough that the text orders films: ${v.confidence.toFixed(2)}, under ${guardMinConfidence.toFixed(2)}.`
        : 'The text does not order films: gibberish, a language not understood, or off topic.';
    throw new Rejection('invalid_request', detail, { guard: v });
  }
}

/** What a reading took up to a bug, for its trace: a bug is no error of ours to carry a report. */
const bugReports = new WeakMap<object, Report>();

/** What the reading that threw `error` took, whatever the error. */
export function reportOf(error: unknown): Report | undefined {
  if (error instanceof Rejection || error instanceof EngineError) return error.report;
  return typeof error === 'object' && error !== null ? bugReports.get(error) : undefined;
}

/** "q_" and 16 random base32 characters: 80 bits. */
function newQuoteId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return 'q_' + Array.from(randomBytes(16), (b) => alphabet[b % 32]).join('');
}

/**
 * One reading under way: the request's signal, and what its stages took,
 * added up stage by stage over the attempts.
 */
class Run {
  readonly signal: AbortSignal;
  /** The attempt the stages run for, 1 for the first reading; undefined before the reading starts. */
  readonly attempt: number | undefined;
  /** What every view of the run shares: the stages' usage, and how many readings were started. */
  readonly #shared: { stages: Usage[]; readings: number };

  constructor(signal: AbortSignal, attempt?: number, shared = { stages: [] as Usage[], readings: 0 }) {
    this.signal = signal;
    this.attempt = attempt;
    this.#shared = shared;
  }

  /** The same run, its stages now those of an attempt. */
  at(attempt: number): Run {
    this.#shared.readings = Math.max(this.#shared.readings, attempt);
    return new Run(this.signal, attempt, this.#shared);
  }

  /** Adds what a stage took to what it took on earlier attempts; its engine is the first one's. */
  #account(stage: Stage, usage: EngineUsage, ms: number): void {
    const before = this.#shared.stages.find((u) => u.stage === stage);
    if (!before) {
      this.#shared.stages.push({ ...usage, stage, ms });
      return;
    }
    if (before.model === undefined && usage.model !== undefined) before.model = usage.model;
    before.calls += usage.calls;
    before.costUsd += usage.costUsd;
    before.ms += ms;
  }

  /**
   * Runs one stage in its span: `call` asks the engine, on the request's
   * signal unless given another; `take` makes the stage's value of the
   * answer, or refuses it. Accounts for what the engine took, and traces the
   * value (as `show` shows it), the refusal or the failure. A failure once
   * the signal has aborted is the engine's: it did not answer in time.
   */
  stage<A extends { usage: EngineUsage }, T>(
    stage: Stage,
    call: (call: Call) => Promise<A>,
    take: (answer: NoInfer<A>) => T,
    {
      signal = this.signal,
      show = (value: T): unknown => value,
    }: { signal?: AbortSignal; show?: (value: T) => unknown } = {},
  ): Promise<T> {
    const metadata = this.attempt === undefined ? undefined : { attempt: this.attempt };
    return observe(
      stage,
      OBSERVATION_TYPES[stage],
      async (span) => {
        const started = performance.now();
        const account = (usage: EngineUsage) => {
          // engines that time their own calls keep their measure
          this.#account(stage, usage, usage.ms ?? Math.round(performance.now() - started));
        };
        let answer: A;
        try {
          answer = await call({ signal });
        } catch (error) {
          const failure =
            error instanceof EngineError || !signal.aborted
              ? error
              : new EngineError('no answer in time', { cause: error });
          // a stage that failed still ran: a refusal beside it reports what it took
          account(failure instanceof EngineError && failure.usage ? failure.usage : UNKNOWN);
          // a call cancelled (the client gone, or the parse failed beside it) did not fail; one past the deadline did
          if (!isCancelled(signal)) span.fail(failure);
          throw named(stage, failure);
        }
        account(answer.usage);
        try {
          const value = take(answer);
          span.update({ output: show(value) });
          return value;
        } catch (error) {
          // a refusal is the stage's answer, not its failure
          if (error instanceof Rejection) span.update({ output: refusal(error) });
          else span.fail(error);
          throw named(stage, error);
        }
      },
      metadata,
    );
  }

  /** The stages that ran, in pipeline order, their total cost, and the readings made. */
  report(): Omit<Report, 'ms'> {
    const stages = this.#shared.stages.toSorted((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    return {
      stages,
      costUsd: stages.reduce((total, s) => total + s.costUsd, 0),
      ...(this.#shared.readings > 0 && { attempts: this.#shared.readings }),
    };
  }
}

/** An engine's failure, prefixed with the stage it failed; anything else as is. */
function named(stage: Stage, error: unknown): unknown {
  if (!(error instanceof EngineError)) return error;
  return new EngineError(`${stage}: ${error.message}`, {
    cause: error.cause,
    ...(error.usage && { usage: error.usage }),
  });
}

/**
 * The findings of a reading judged before, in the order of `lines`, the same
 * lines read in another order: each line's asked and identity, by its title,
 * then missing.
 */
function inLineOrder(findings: readonly Finding[], lines: readonly Line[]): Finding[] {
  const byTitle = Map.groupBy(
    findings.filter((f) => f.check !== 'missing'),
    (f) => f.label,
  );
  return [...lines.flatMap((l) => byTitle.get(l.title) ?? []), ...findings.filter((f) => f.check === 'missing')];
}

function refusal(rejection: Rejection): { code: string; detail: string } {
  return { code: rejection.code, detail: rejection.detail };
}
