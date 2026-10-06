import { FILMS, type Film, type Line, type Mention } from '../src/cart.ts';
import { Pipeline } from '../src/pipeline/pipeline.ts';
import {
  EngineError,
  type Engines,
  type EngineUsage,
  type Finding,
  type Identification,
  type Stage,
  type Usage,
} from '../src/pipeline/ports.ts';
import { Identifications, countFindings, merge, refusalOf, verdictOf } from '../src/pipeline/reading.ts';
import { Rejection, type Judgement, type Verdict } from '../src/pipeline/rejection.ts';
import { normalize } from '../src/prepare/normalize.ts';
import { TokenCounter } from '../src/prepare/tokens.ts';
import { DEFAULT_CATALOG } from '../src/pricing.ts';
import { titleKey } from '../src/text.ts';
import type { Case } from './cases.ts';
import { Stats, type StageUsage } from './stats.ts';

/**
 * What a stage bench plays: a stage, or a few, alone, against cases whose answer is known. A subject is played
 * several times per case: a model does not answer twice the same, and one pass proves little.
 *
 * The subjects are wired directly to the quoter's own engines (the guard, the identifier, the readers, the
 * judge of src/), and the pipeline's own rules (the verdict of the guard's answers, the merge of a reading, the
 * count checks): what is measured is what the service runs.
 */

/** The component benches, by name (the folder of their cases, and their Langfuse dataset), with what each tests. */
export const SUBJECTS = {
  guard: 'The guard alone: is a text a cart (valid), an attempt to steer the system (injection), or neither (invalid)?',
  identify: 'One title as a customer wrote it, in any language or spelling: which film is it?',
  reading:
    "The pipeline's reading: parse beside the recount, identify, judge, read again while the judge refuses: the films a text buys, and how many copies of each.",
  judge:
    'The judge, with the recount it compares against: is a reading faithful to the text it was read from, and which check says it is not?',
  parse:
    'The first reading alone: the parse, then identify, on the reading cases: the films a text buys, what the parse costs and how long it takes.',
} as const;

export type SubjectName = keyof typeof SUBJECTS;

export function isSubject(name: string): name is SubjectName {
  return Object.hasOwn(SUBJECTS, name);
}

/** The subjects, sorted. */
export function subjectNames(): SubjectName[] {
  return (Object.keys(SUBJECTS) as SubjectName[]).toSorted();
}

/** The folder of a subject's cases: its own, but for parse, which reads the reading cases. */
export function folderOf(subject: SubjectName): string {
  return subject === 'parse' ? 'reading' : subject;
}

/** What the subjects are played with. */
export interface Setup {
  engines: Engines;
  /** The prompt files' versions, each the hash of its file: a run says what questions it asked. */
  versions: { guard: string; parse: string; identify: string; judge: string };
  /** The models behind the engines, for the variant: "jev-1.13", "gpt-6-luna (minimal)". */
  jev: string;
  llm: string;
  recount: string;
  /** The least confidence of a valid verdict the pipeline accepts; the judge's threshold; the most readings of a cart. */
  guardMinConfidence: number;
  judgeThreshold: number;
  readAttempts: number;
  /** The time the recount has in a reading; 0 gives it the request's whole budget. */
  recountTimeoutMs?: number;
}

/** The score of one check of an answer, 0 to 1, and why. */
export interface Scoring {
  score: number;
  reason: string;
}

/**
 * One check of an answer, scored from 0 to 1. A run passes a case when every metric reaches its threshold; a
 * metric at threshold 0 is only reported.
 */
export interface Metric {
  name: string;
  threshold: number;
  /** Scores the answer against the case, in code. */
  check(answer: unknown, c: Case): Scoring;
}

/** What a play came to: its answer, what its stages took, and why it failed when it did. */
export interface Played {
  answer?: unknown;
  usage: StageUsage[];
  error?: Error;
}

export interface Subject {
  /** The Langfuse dataset, and the name of the folder's subject. */
  name: SubjectName;
  description: string;
  /** What is tested: the models, the versions of the questions and prompts. It goes into the run name. */
  variant: string;
  /** Answers one case's input with the engines under test. It never throws: a failure is in `error`. */
  play(input: unknown): Promise<Played>;
  metrics: Metric[];
  /** The most readings a play makes of a cart, for the subject that reads again. */
  readAttempts?: number;
  /** What the plays took. */
  stats: Stats;
}

/** Builds the subject called `name` on `setup`'s engines. It calls nothing: the calls start with a run. */
export function newSubject(name: SubjectName, setup: Setup): Subject {
  const { engines, versions: v, jev, llm, recount, guardMinConfidence: floor, judgeThreshold: threshold } = setup;
  const version = (stage: Stage) => `${stage} ${stage === 'recount' ? v.parse : v[stage as keyof typeof v]}`;
  const base = { name, description: SUBJECTS[name], stats: new Stats() };
  switch (name) {
    case 'guard':
      return {
        ...base,
        variant: `${jev} · ${version('guard')} · min confidence ${floor.toFixed(2)}`,
        play: playGuard(engines),
        metrics: [
          {
            name: 'decision',
            threshold: 1,
            check: check((got: GuardAnswer, want: { verdict: Verdict }) => {
              const gave = decision(got.verdict, got.confidence, floor);
              const wanted = decision(want.verdict, 1, floor);
              let why = `${got.verdict} ${got.confidence.toFixed(2)}`;
              if (got.verdict === 'valid' && got.confidence < floor) why += ` under ${floor.toFixed(2)}`;
              return [gave === wanted, `${why} → ${gave}, expected ${wanted}${answers(got)}`];
            }),
          },
          // the raw verdict, what the first runs scored: kept to compare with them, it fails no case
          {
            name: 'verdict',
            threshold: 0,
            check: check((got: GuardAnswer, want: { verdict: Verdict }) => [
              got.verdict === want.verdict,
              `${got.verdict} ${got.confidence.toFixed(2)}, expected ${want.verdict}${answers(got)}`,
            ]),
          },
        ],
      };
    case 'identify':
      return {
        ...base,
        variant: `${jev} · ${version('identify')}`,
        play: playIdentify(engines),
        metrics: [
          {
            name: 'film',
            threshold: 1,
            check: check((got: IdentifyAnswer, want: { film: Film }) => [
              got.film === want.film,
              `${got.film} ${got.confidence.toFixed(2)}, expected ${want.film}`,
            ]),
          },
        ],
      };
    case 'parse':
      return {
        ...base,
        variant: `${llm} + ${jev} · ${version('parse')} · ${version('identify')} · parse + identify`,
        play: playParse(engines),
        metrics: [
          {
            name: 'films',
            threshold: 1,
            check: check((got: ReadingAnswer, want: ReadingExpect) => [
              sameFilms(got.films, want.films),
              `read ${filmsText(got.films)}, expected ${filmsText(want.films)}`,
            ]),
          },
        ],
      };
    case 'reading': {
      const attempts = Math.max(setup.readAttempts, 1);
      return {
        ...base,
        readAttempts: attempts,
        variant:
          `${llm} + recount ${recount} + ${jev} · ${version('parse')} · ${version('identify')} · ${version('judge')}` +
          ` · threshold ${threshold.toFixed(2)} · up to ${attempts} readings`,
        play: playReading(setup, attempts),
        metrics: [
          // the reading priced, or refused: the last
          {
            name: 'films',
            threshold: 1,
            check: check((got: ReadingAnswer, want: ReadingExpect) => [
              sameFilms(got.films, want.films),
              `read ${filmsText(got.films)} in ${got.attempts} readings, expected ${filmsText(want.films)}`,
            ]),
          },
          // the first reading, what the pipeline read before any retry: set against films, what reading again
          // recovers. It fails no case.
          {
            name: 'first',
            threshold: 0,
            check: check((got: ReadingAnswer, want: ReadingExpect) => [
              sameFilms(got.first, want.films),
              `read ${filmsText(got.first)} first, expected ${filmsText(want.films)}`,
            ]),
          },
          { name: 'judge', threshold: 1, check: judgeCall(threshold) },
        ],
      };
    }
    case 'judge':
      return {
        ...base,
        variant:
          `${jev} + recount ${recount} · ${version('recount')} · ${version('identify')} · ${version('judge')}` +
          ` · threshold ${threshold.toFixed(2)}`,
        play: playJudge(engines),
        metrics: [
          {
            name: 'faithful',
            threshold: 1,
            check: check((got: JudgeAnswer, want: JudgeExpect) => {
              const held = got.score >= threshold;
              return [
                held === want.faithful,
                `worst ${got.score.toFixed(2)} (${worst(got)}), held ${faithful(held)}, expected ${faithful(want.faithful)}`,
              ];
            }),
          },
          {
            name: 'check',
            threshold: 1,
            check: check((got: JudgeAnswer, want: JudgeExpect) => {
              if (want.faithful || !want.check) return [true, 'no failing check expected'];
              const caught = got.findings.find((f) => f.check === want.check && f.score < threshold);
              return caught
                ? [true, `${caught.check} caught it: ${JSON.stringify(caught.label)} ${caught.score.toFixed(2)}`]
                : [false, `no ${want.check} check under ${threshold.toFixed(2)}; worst ${worst(got)}`];
            }),
          },
        ],
      };
  }
}

/** A metric's check made of `f`, which reads the answer and the case's expect and says whether they agree. */
function check(f: (got: never, want: never) => [boolean, string]): Metric['check'] {
  return (answer, c) => {
    const [ok, reason] = f(answer as never, c.expect as never);
    return { score: ok ? 1 : 0, reason };
  };
}

interface GuardAnswer {
  verdict: Verdict;
  confidence: number;
  probabilities: Record<Verdict, number>;
  questions: { order: number; steer: number };
}

interface IdentifyAnswer {
  film: Film;
  confidence: number;
}

interface ReadingExpect {
  films: Partial<Record<Film, number>>;
}

/** The last reading judged, the one priced or refused, with its recount and its judgement; and the first reading's films. */
interface ReadingAnswer {
  lines: Line[];
  films: Partial<Record<Film, number>>;
  recount: Line[];
  judge?: JudgeAnswer;
  attempts: number;
  first: Partial<Record<Film, number>>;
}

interface JudgeExpect {
  faithful: boolean;
  check?: Finding['check'];
}

interface JudgeAnswer {
  score: number;
  findings: Finding[];
}

/** What the service does with a cart the guard lets through. */
const ACCEPTED = 'accepted';

/**
 * What the service does with a verdict (the pipeline's rule): a cart goes on when it is valid with at least
 * `floor` confidence, and is refused otherwise, as injection or as invalid_request. What a case expects is its
 * verdict at confidence 1.
 */
function decision(verdict: Verdict, confidence: number, floor: number): string {
  if (verdict === 'valid' && confidence >= floor) return ACCEPTED;
  return verdict === 'injection' ? 'injection' : 'invalid_request';
}

/** The guard's two answers, which made its verdict, for a reason. */
function answers(a: GuardAnswer): string {
  return ` · order ${a.questions.order.toFixed(2)}, steer ${a.questions.steer.toFixed(2)}`;
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** What a stage's engine reported, as the usage of that stage; the time is the engine's own, or what it took. */
function usageOf(stage: Stage, usage: EngineUsage, started: number): StageUsage {
  return {
    stage,
    calls: usage.calls,
    costUsd: usage.costUsd,
    ms: usage.ms ?? Math.round(performance.now() - started),
  };
}

/**
 * Asks an engine, and keeps what the stage took in `usage` whether it answered or failed: a call that failed
 * still cost, and still took its time.
 */
async function ask<A extends { usage: EngineUsage }>(
  stage: Stage,
  usage: StageUsage[],
  call: () => Promise<A>,
): Promise<A> {
  const started = performance.now();
  try {
    const answer = await call();
    usage.push(usageOf(stage, answer.usage, started));
    return answer;
  } catch (error) {
    const taken = error instanceof EngineError ? error.usage : undefined;
    usage.push(usageOf(stage, taken ?? { engine: 'unknown', calls: 0, costUsd: 0 }, started));
    throw error;
  }
}

const NEVER = new AbortController().signal;

/** Plays that read the case's input: the pipeline normalizes the text before any stage, and so does every play. */
function playing(run: (input: never, usage: StageUsage[]) => Promise<unknown>): (input: unknown) => Promise<Played> {
  return async (input) => {
    const usage: StageUsage[] = [];
    try {
      return { answer: await run(input as never, usage), usage };
    } catch (error) {
      return { usage, error: asError(error) };
    }
  };
}

function playGuard(engines: Engines): Subject['play'] {
  return playing(async ({ text }: { text: string }, usage) => {
    const answered = await ask('guard', usage, () => engines.guard.check(normalize(text), { signal: NEVER }));
    const { verdict, confidence, probabilities, questions } = verdictOf(answered);
    return { verdict, confidence, probabilities, questions } satisfies GuardAnswer;
  });
}

function playIdentify(engines: Engines): Subject['play'] {
  return playing(async ({ title }: { title: string }, usage) => {
    const { identifications } = await ask('identify', usage, () =>
      engines.identifier.identify([normalize(title)], { signal: NEVER }),
    );
    const [only, ...others] = identifications;
    if (!only || others.length > 0) {
      throw new EngineError(`${identifications.length} identifications for one title`);
    }
    return { film: only.film, confidence: only.confidence } satisfies IdentifyAnswer;
  });
}

/** The copies of each film in lines. */
function filmsOf(lines: readonly Line[]): Partial<Record<Film, number>> {
  const out: Partial<Record<Film, number>> = {};
  for (const l of lines) out[l.film] = (out[l.film] ?? 0) + l.quantity;
  return out;
}

/**
 * Reads as the pipeline's first reading does: the parse, its mentions merged, its titles identified, without the
 * recount, the judge or a second reading: what a parser variant changes. Each usage names its stage, so that the
 * parse's latency and cost, and identify's, are counted apart. No film is a reading of nothing; too many copies
 * fails the play.
 */
function playParse(engines: Engines): Subject['play'] {
  return playing(async ({ text }: { text: string }, usage) => {
    const { mentions } = await ask('parse', usage, () => engines.parser.read(normalize(text), { signal: NEVER }));
    const read = merge(mentions);
    const refusal = refusalOf(read);
    if (refusal && refusal.code !== 'no_film') throw refusal;
    if (read.length === 0) return { lines: [], films: {}, recount: [], attempts: 1, first: {} } satisfies ReadingAnswer;
    const lines = await identified(engines, usage, read);
    return { lines, films: filmsOf(lines), recount: [], attempts: 1, first: filmsOf(lines) } satisfies ReadingAnswer;
  });
}

/** The lines of a reading, its titles put to the identifier once each. */
async function identified(engines: Engines, usage: StageUsage[], read: readonly Mention[]): Promise<Line[]> {
  const known = new Identifications();
  const titles = known.unknown(read);
  const { identifications } = await ask('identify', usage, () =>
    engines.identifier.identify(titles, { signal: NEVER }),
  );
  known.learn(titles, identifications);
  return known.lines(read);
}

/**
 * What the pipeline's engines were asked and answered during one play: the reading of each attempt, the first
 * recount that succeeded, and each title's film. A refused reading comes back as a Rejection with a judgement
 * but not the reading it judged; this is where the bench finds it.
 */
interface Seen {
  parses: Mention[][];
  recount: Mention[] | undefined;
  films: Map<string, Identification>;
}

/** `engines`, as they were, but that each answer is kept in `seen`. */
function observed(engines: Engines, seen: Seen): Engines {
  const merged = (mentions: readonly Mention[]): Mention[] | undefined => {
    try {
      return merge(mentions);
    } catch {
      return undefined;
    }
  };
  return {
    ...engines,
    // the guard is not part of a reading: whatever its answer, the text goes on
    guard: { check: () => Promise.resolve({ order: 1, steer: 0, usage: { engine: 'bench', calls: 0, costUsd: 0 } }) },
    parser: {
      async read(text, call, retry) {
        const answer = await engines.parser.read(text, call, retry);
        const read = merged(answer.mentions);
        if (read) seen.parses.push(read);
        return answer;
      },
    },
    recounter: {
      async read(text, call, retry) {
        const answer = await engines.recounter.read(text, call, retry);
        seen.recount ??= merged(answer.mentions);
        return answer;
      },
    },
    identifier: {
      async identify(titles, call) {
        const answer = await engines.identifier.identify(titles, call);
        titles.forEach((title, i) => {
          const id = answer.identifications[i];
          if (id) seen.films.set(titleKey(title), id);
        });
        return answer;
      },
    },
  };
}

/** The lines of a reading, from what the identifier said of its titles. */
function linesOf(seen: Seen, read: readonly Mention[] | undefined): Line[] {
  return (read ?? []).flatMap((m) => {
    const id = seen.films.get(titleKey(m.title));
    return id ? [{ ...m, film: id.film, confidence: id.confidence }] : [];
  });
}

const judged = (j: Judgement): JudgeAnswer => ({
  score: j.score,
  findings: j.findings.map(({ check, label, score }) => ({ check, label, score })),
});

/**
 * Reads as the pipeline does, with its own loop: the text goes through the pipeline from the parse to the judge,
 * without the guard (a stage of its own, played by its own bench), and what it takes is read from the pipeline's
 * report. A text with no film to buy reads as nothing; a reading the judge refuses after every attempt is the
 * answer, with its judgement: the bench scores the judge on it. A cart the pipeline refuses for any other reason
 * (too many copies, no recount to count the quantities against) fails the play with its reason.
 */
function playReading(setup: Setup, readAttempts: number): Subject['play'] {
  const { engines } = setup;
  return async (input) => {
    const { text } = input as { text: string };
    const seen: Seen = { parses: [], recount: undefined, films: new Map() };
    const pipeline = new Pipeline({
      engines: observed(engines, seen),
      counter: tokenCounter(),
      catalog: DEFAULT_CATALOG,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      guardMinConfidence: 0,
      judgeThreshold: setup.judgeThreshold,
      readAttempts,
      ...(setup.recountTimeoutMs !== undefined && { recountTimeoutMs: setup.recountTimeoutMs }),
    });
    const usageOfReport = (stages: readonly Usage[]): StageUsage[] =>
      stages
        .filter((s) => s.stage !== 'prepare' && s.stage !== 'guard' && s.stage !== 'price')
        .map(({ stage, calls, costUsd, ms }) => ({ stage, calls, costUsd, ms }));
    try {
      const quote = await pipeline.quote({ cart: text }, NEVER);
      const lines = quote.price.lines.map(({ title, quantity, film, confidence }) => ({
        title,
        quantity,
        film,
        confidence,
      }));
      const answer: ReadingAnswer = {
        lines,
        films: filmsOf(lines),
        recount: linesOf(seen, seen.recount),
        judge: judged(quote.judgement),
        attempts: quote.judgement.attempts,
        first: filmsOf(linesOf(seen, seen.parses[0])),
      };
      return { answer, usage: usageOfReport(quote.report.stages) };
    } catch (error) {
      if (!(error instanceof Rejection) && !(error instanceof EngineError)) return { usage: [], error: asError(error) };
      const usage = usageOfReport(error.report?.stages ?? []);
      if (error instanceof Rejection && error.code === 'no_film') {
        return { answer: { lines: [], films: {}, recount: [], attempts: 0, first: {} } satisfies ReadingAnswer, usage };
      }
      const last = error instanceof Rejection ? error.facts.judgement : undefined;
      if (error instanceof Rejection && error.code === 'unfaithful_reading' && last) {
        const lines = linesOf(seen, seen.parses[last.attempts - 1]);
        const answer: ReadingAnswer = {
          lines,
          films: filmsOf(lines),
          recount: linesOf(seen, seen.recount),
          judge: judged(last),
          attempts: last.attempts,
          first: filmsOf(linesOf(seen, seen.parses[0])),
        };
        return { answer, usage };
      }
      return { usage, error };
    }
  };
}

let counter: TokenCounter | undefined;

/** The pipeline wants a counter for its prepare stage; the bench's cart limit is none, but the count is made. */
function tokenCounter(): TokenCounter {
  counter ??= new TokenCounter();
  return counter;
}

/**
 * Judges the case's reading as the pipeline would: the recount reads the case's text and its titles are
 * identified (the count check compares the reading with them), then the judge puts its questions.
 */
function playJudge(engines: Engines): Subject['play'] {
  return playing(async (input: { text: string; lines: { title: string; quantity: number; film: Film }[] }, usage) => {
    const text = normalize(input.text);
    const lines: Line[] = input.lines.map((l) => ({ ...l, confidence: 1 }));
    const { mentions } = await ask('recount', usage, () => engines.recounter.read(text, { signal: NEVER }));
    const recount = merge(mentions);
    const recounted = recount.length === 0 ? [] : await identified(engines, usage, recount);
    const { findings } = await ask('judge', usage, () => engines.judge.judge(text, lines, { signal: NEVER }));
    const all = [...findings, ...countFindings(lines, recounted)];
    return judged({ score: Math.min(1, ...all.map((f) => f.score)), findings: all, attempts: 1 });
  });
}

/**
 * Scores the judge's call on the reading priced or refused: the judge as the bench's evaluator: a right reading
 * must be held, a wrong one refused. On a case tagged injection, refusing a right reading is right too: the text
 * tried to steer the reading, and a refusal prices nothing.
 */
function judgeCall(threshold: number): Metric['check'] {
  return (answer, c) => {
    const got = answer as ReadingAnswer;
    if (!got.judge) return { score: 1, reason: 'nothing read: the pipeline answers no_film before the judge' };
    const want = c.expect as ReadingExpect;
    const right = sameFilms(got.films, want.films);
    const held = got.judge.score >= threshold;
    const why =
      `${held ? 'held' : 'refused'} a ${right ? 'right' : 'wrong'} reading after ${got.attempts}, ` +
      `worst ${worst(got.judge)} of ${got.judge.findings.length} checks`;
    if (right === held) return { score: 1, reason: why };
    if (right && c.tags?.includes('injection')) return { score: 1, reason: `${why}: safe on an injection` };
    return { score: 0, reason: why };
  };
}

/** The finding that scores the judgement, in words. */
function worst(a: JudgeAnswer): string {
  const [first, ...rest] = a.findings;
  if (!first) return 'no finding';
  const w = rest.reduce((low, f) => (f.score < low.score ? f : low), first);
  return `${w.check} ${JSON.stringify(w.label)} ${w.score.toFixed(2)}`;
}

const faithful = (held: boolean): string => (held ? 'faithful' : 'unfaithful');

/** Compares totals by film; a film at 0 is a film absent. */
function sameFilms(a: Partial<Record<Film, number>> = {}, b: Partial<Record<Film, number>> = {}): boolean {
  return FILMS.every((f) => (a[f] ?? 0) === (b[f] ?? 0));
}

/** A {film: quantity} map in the order of FILMS, for a reason. */
function filmsText(m: Partial<Record<Film, number>> = {}): string {
  const out = FILMS.filter((f) => (m[f] ?? 0) > 0).map((f) => `${f}×${m[f]}`);
  return out.length === 0 ? 'nothing' : out.join(' ');
}
