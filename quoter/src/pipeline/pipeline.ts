import { randomBytes } from 'node:crypto';
import type { Line, Mention } from '../cart.ts';
import { normalize } from '../prepare/normalize.ts';
import { titleKey } from '../text.ts';
import type { TokenCounter } from '../prepare/tokens.ts';
import { price, type Catalog, type Price } from '../pricing.ts';
import { observe, type ObservationType } from '../telemetry/trace.ts';
import {
  EngineError,
  engineFailure,
  isCancelled,
  type Answered,
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
 * The recount reads the cart a second time, beside the parse; the judge
 * compares the two readings. The recount is a second opinion: one that fails
 * does not fail the quote, which goes on without it (degraded). prepare and
 * price are plain code and never call a model.
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
  /**
   * The time the recount has, a retry included: past it the reading goes on
   * without the recount (degraded). It is tried a second time when the first
   * failed in under half of it. 0 or undefined gives it the request's whole
   * budget and no retry.
   */
  recountTimeoutMs?: number;
  /** The clock the recount's "failed in under half of its time" is read on, in milliseconds; a test moves its own. */
  now?: () => number;
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
const STAGES: readonly Stage[] = ['prepare', 'guard', 'parse', 'recount', 'identify', 'judge', 'price'];

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

/**
 * A reading and its recount: the parser's mentions as decoded and merged, the
 * recount's merged; no recount (undefined) when it degraded.
 */
interface Reading {
  decoded: Mention[];
  read: Mention[];
  recounted: Mention[] | undefined;
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
    // The first recount that succeeded. It reads blind, its input never changes between readings:
    // later readings are counted against it and do not ask it again. One that failed is asked anew.
    let kept: Mention[] | undefined;
    // the first reading named no film: it is read once more, told so
    let emptyFirst = false;

    for (let attempt = 1; attempt <= readAttempts; attempt++) {
      try {
        const at = run.at(attempt);
        // A first reading with no film is read once more before the cart is refused no_film (at once when there
        // is no second reading to make); a second one with none is final.
        const refuseNoFilm = (attempt === 1 && readAttempts === 1) || (attempt === 2 && emptyFirst);
        const { decoded, read, recounted } = await this.#readTwice(at, text, retry, refuseNoFilm, kept);
        if (attempt === 1 && read.length === 0) emptyFirst = true;
        kept ??= recounted;
        if (read.length === 0) {
          // a reading without film, the first included: the text has not changed
          // since, the model has; a failed attempt, not put to Jev
          judgement = {
            score: 0,
            findings: [{ check: 'missing', label: 'the whole reading', score: 0 }],
            attempts: attempt,
          };
          retry = { previous: decoded, failed: judgement.findings };
          continue;
        }

        // titles already identified in this request are not asked again; without a recount, the parse's only
        const readings = recounted === undefined ? [read] : [read, recounted];
        const unknown = identifications.unknown(...readings);
        const [lines, recountedLines] = await at.stage(
          'identify',
          (call) =>
            unknown.length > 0
              ? engines.identifier.identify(unknown, call)
              : Promise.resolve({ identifications: [], usage: NOT_ASKED }),
          ({ identifications: answers }) => {
            identifications.learn(unknown, answers);
            return [
              identifications.lines(read),
              recounted === undefined ? undefined : identifications.lines(recounted),
            ] as const;
          },
          { show: ([reading, recount]) => ({ reading, recount: recount ?? null }) },
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
            // without a recount (degraded) there is nothing to count against
            const all = [...findings, ...(recountedLines === undefined ? [] : countFindings(lines, recountedLines))];
            return { score: Math.min(1, ...all.map((f) => f.score)), findings: all, attempts: attempt };
          },
        );
        if (judgement.score >= judgeThreshold) {
          // No recount succeeded in the request (degraded): nothing counts the quantities. A cart of single
          // copies is priced; a line of several is not, and the same cart may be priced on a retry.
          if (kept === undefined && lines.some((l) => l.quantity > 1)) {
            // a title written on many lines is a cart no recount gets through, one try after another: group it
            const repeated = repeatedTitle(decoded, lines);
            throw repeated
              ? new Rejection(
                  'repeated_titles',
                  `The cart repeats a title on many lines and its quantities could not be cross-checked in time: group them, for example ${JSON.stringify(`${repeated.quantity} x ${repeated.title}`)}.`,
                )
              : new Rejection(
                  'quantity_unverified',
                  'The quantities could not be cross-checked and a line asks for more than one copy: try again.',
                );
          }
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
      } catch (error) {
        // A reading that follows an unfaithful one and fails (a model too slow, down, off its contract) is
        // no outage to retry: the cart that was refused is the likely cause, and the customer can reword it.
        // Only a client that went away, a failure of the first reading, or a bug stays what it is.
        if (judgement === undefined || !(error instanceof EngineError) || isCancelled(run.signal)) throw error;
        throw this.#unfaithful(judgement, error);
      }
    }

    throw this.#unfaithful(judgement ?? { score: 0, findings: [], attempts: readAttempts });
  }

  /**
   * The refusal of a cart whose readings were all judged unfaithful, with the last judgement. `failure` is the
   * engine error of a later reading that did not finish: it stays the refusal's cause, for the log and the trace.
   */
  #unfaithful(last: Judgement, failure?: EngineError): Rejection {
    const { judgeThreshold } = this.config;
    const why = `its worst score, ${last.score.toFixed(2)}, is under ${judgeThreshold.toFixed(2)}`;
    const detail =
      failure === undefined
        ? `The judge does not hold the reading faithful to the text: ${why}.`
        : `The judge did not hold the reading faithful to the text (${why}) and the reading that followed did not finish: reword the cart.`;
    return new Rejection('unfaithful_reading', detail, { judgement: last }, failure);
  }

  /**
   * Reads the text with the parser and the recounter side by side; the
   * report has both, the parse first. The parse decides first: its failure,
   * then its refusal, then the recount's failure. Too many copies of a title
   * is refused on any reading, a safety limit; no film only when `refuseNoFilm`
   * says it is final (the second reading of a cart whose first had none, or the
   * only one); any other reading with no film comes back empty, and fails. A parse that fails
   * stops the recount, whose reading no longer matters; one that refuses
   * waits for it, and the refusal reports what both took.
   *
   * Once a recount succeeded (`kept`) it is not asked again: only the parse
   * runs, and the kept recount comes back for this reading too.
   *
   * The recount is a second opinion: one that fails, answers off its schema or
   * is too slow (#recount) does not fail the quote. The reading goes on
   * without it — no recount, no count check, the stage's usage degraded — and
   * the judge stays the guard. Only a request that is over fails on the
   * recount.
   */
  async #readTwice(
    run: Run,
    text: string,
    retry: Retry | undefined,
    refuseNoFilm: boolean,
    kept: Mention[] | undefined,
  ): Promise<Reading> {
    const { parser } = this.config.engines;
    const stopRecount = new AbortController();
    const parse = run
      .stage(
        'parse',
        (call) => parser.read(text, call, retry),
        ({ mentions, unreadable }) => {
          if (unreadable !== undefined) throw new Rejection('demo_unreadable', demoUnreadable(unreadable));
          return { decoded: mentions, read: merge(mentions) };
        },
        { show: ({ read }) => read },
      )
      .catch((error: unknown) => {
        stopRecount.abort(error);
        throw error;
      });
    const [parsed, recount] = await Promise.allSettled([
      parse,
      // a recount that succeeded stands for this reading too: no call, span or usage
      kept !== undefined
        ? Promise.resolve(kept)
        : run.stage<Answered<{ mentions: Mention[] }>, Mention[] | undefined>(
            'recount',
            (call) => this.#recount(text, call),
            ({ mentions }) => mentions,
            {
              signal: AbortSignal.any([run.signal, stopRecount.signal]),
              // a recount that fails beside a parse that fails is cancelled, not degraded: the parse decides first
              degrade: { value: () => undefined, after: parse },
            },
          ),
    ]);
    if (parsed.status === 'rejected') throw parsed.reason;
    const { decoded, read } = parsed.value;
    const refusal = refusalOf(read);
    if (refusal && (refuseNoFilm || refusal.code === 'quantity_too_large')) throw refusal;
    if (recount.status === 'rejected') throw recount.reason;
    return { decoded, read, recounted: recount.value };
  }

  /**
   * The recounter's reading, merged, within `recountTimeoutMs`: a second
   * time, when the first call failed in under half of it — an answer off its
   * schema comes quickly, a slow model does not get faster — with what is
   * left. The usage adds up both calls. Not a word to the recounter about
   * what failed: it reads blind.
   */
  async #recount(text: string, { signal }: Call): Promise<Answered<{ mentions: Mention[] }>> {
    const { engines, recountTimeoutMs = 0, now = () => performance.now() } = this.config;
    const budget = recountTimeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(recountTimeoutMs)]) : signal;
    const once = async (): Promise<Answered<{ mentions: Mention[] }>> => {
      const answer = await engines.recounter.read(text, { signal: budget });
      try {
        return { mentions: merge(answer.mentions), usage: answer.usage };
      } catch (error) {
        // an answer off the reader's contract was still a call, and costs
        throw error instanceof EngineError ? engineFailure(error, answer.usage) : error;
      }
    };
    // the recount's own time running out is an engine that did not answer in time; the request's, or a
    // cancellation, is not
    const timedOut = (error: unknown): unknown =>
      error instanceof EngineError || signal.aborted || !budget.aborted
        ? error
        : new EngineError('no answer in time', { cause: error, usage: { ...UNKNOWN, calls: 1 } });
    const started = now();
    try {
      return await once();
    } catch (error) {
      if (
        recountTimeoutMs <= 0 ||
        budget.aborted ||
        !(error instanceof EngineError) ||
        now() - started >= recountTimeoutMs / 2
      ) {
        throw timedOut(error);
      }
      const first = error.usage ?? UNKNOWN;
      try {
        const again = await once();
        return { mentions: again.mentions, usage: added(first, again.usage) };
      } catch (retried) {
        const failure = timedOut(retried);
        if (!(failure instanceof EngineError)) throw failure;
        throw engineFailure(failure, added(first, failure.usage ?? UNKNOWN));
      }
    }
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

/** From how many mentions of one title a cart is said to repeat it, and is asked to group them. */
export const REPEATED_MENTIONS = 5;

/** The first line of a reading that was made of at least `REPEATED_MENTIONS` mentions of the parse, if any. */
function repeatedTitle(decoded: readonly Mention[], lines: readonly Line[]): Line | undefined {
  const mentions = Map.groupBy(decoded, (m) => titleKey(m.title));
  return lines.find((l) => (mentions.get(titleKey(l.title))?.length ?? 0) >= REPEATED_MENTIONS);
}

/** Two calls of one engine as one usage: calls and cost added; their time too when both timed themselves. */
function added(a: EngineUsage, b: EngineUsage): EngineUsage {
  const model = a.model ?? b.model;
  return {
    engine: a.engine === UNKNOWN.engine ? b.engine : a.engine,
    ...(model !== undefined && { model }),
    calls: a.calls + b.calls,
    costUsd: a.costUsd + b.costUsd,
    ...(a.ms !== undefined && b.ms !== undefined && { ms: a.ms + b.ms }),
  };
}

/** Why the demo mode refuses a line: what it reads, and where to read more. */
function demoUnreadable(line: string): string {
  return (
    `The demo mode cannot read the line ${JSON.stringify(line)}. It reads one title per line, with an optional ` +
    'quantity in front: "2 x Back to the Future 2". Write one title per line, or run with the real models to read free text.'
  );
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

  /** Adds what a stage took to what it took on earlier attempts; its engine is the first one's; degraded once, degraded. */
  #account(stage: Stage, usage: EngineUsage, ms: number, degraded = false): void {
    const before = this.#shared.stages.find((u) => u.stage === stage);
    if (!before) {
      this.#shared.stages.push({ ...usage, stage, ms, ...(degraded && { degraded: true }) });
      return;
    }
    if (before.model === undefined && usage.model !== undefined) before.model = usage.model;
    before.calls += usage.calls;
    before.costUsd += usage.costUsd;
    before.ms += ms;
    if (degraded) before.degraded = true;
  }

  /**
   * Runs one stage in its span: `call` asks the engine, on the request's
   * signal unless given another; `take` makes the stage's value of the
   * answer, or refuses it. Accounts for what the engine took, and traces the
   * value (as `show` shows it), the refusal or the failure. A failure once
   * the signal has aborted is the engine's: it did not answer in time. With
   * `degrade`, a failure while the signal is still live once `degrade.after`
   * has settled does not fail the stage: its usage says degraded, its span is
   * a warning, and its value is `degrade.value()`'s.
   */
  stage<A extends { usage: EngineUsage }, T>(
    stage: Stage,
    call: (call: Call) => Promise<A>,
    take: (answer: NoInfer<A>) => T,
    {
      signal = this.signal,
      show = (value: T): unknown => value,
      degrade,
    }: {
      signal?: AbortSignal;
      show?: (value: T) => unknown;
      degrade?: { value: () => T; after?: Promise<unknown> };
    } = {},
  ): Promise<T> {
    const metadata = this.attempt === undefined ? undefined : { attempt: this.attempt };
    return observe(
      stage,
      OBSERVATION_TYPES[stage],
      async (span) => {
        const started = performance.now();
        const account = (usage: EngineUsage, degraded = false, ended = performance.now()) => {
          // engines that time their own calls keep their measure
          this.#account(stage, usage, usage.ms ?? Math.round(ended - started), degraded);
        };
        let answer: A;
        try {
          answer = await call({ signal });
        } catch (error) {
          // as things stood when the call failed, before waiting for anything beside it
          const ended = performance.now();
          const aborted = signal.aborted;
          const cancelled = isCancelled(signal);
          if (degrade) await degrade.after?.catch(() => undefined);
          if (degrade && !signal.aborted && error instanceof EngineError) {
            // an engine's failure of the stage itself, not of the request, nor a bug: the quote goes on without it
            account(error.usage ?? UNKNOWN, true, ended);
            span.warn(error);
            return degrade.value();
          }
          const failure =
            error instanceof EngineError || !aborted ? error : new EngineError('no answer in time', { cause: error });
          // a stage that failed still ran: a refusal beside it reports what it took
          account(failure instanceof EngineError && failure.usage ? failure.usage : UNKNOWN, false, ended);
          // a call cancelled (the client gone, or the parse failed beside it) did not fail; one past the deadline
          // did, and so did a recount that failed on its own as the parse failed, an engine down under both
          const byCancel = cancelled && (degrade === undefined || byCancellation(error, signal));
          if (!byCancel) span.fail(failure);
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

/**
 * Whether `error` is the cancellation of `signal` itself, not a failure of
 * the engine that came at the same time: its reason, or an abort, as is or
 * as the cause of an engine's error.
 */
function byCancellation(error: unknown, signal: AbortSignal): boolean {
  for (let e: unknown = error; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
    if (e === signal.reason) return true;
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return true;
    if (!(e instanceof Error)) return false;
  }
  return false;
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
