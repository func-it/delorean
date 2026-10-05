import type { Line } from '../../cart.ts';
import {
  EngineError,
  engineFailure,
  type Answered,
  type EngineUsage,
  type Finding,
  type Guard,
  type Identifier,
  type Judge,
} from '../../pipeline/ports.ts';
import type { Prompts, Question } from '../../prompts.ts';
import type { Decision, Jev, Request, Tally } from './jev.ts';

/**
 * The stages Jev answers — the guard, the identification, the judge — as
 * requests built from the shared prompts. One request per independent
 * judgement, all in parallel: questions put in the same request colour one
 * another. The customer's text is data: it goes into the state under a key
 * named for what it is, and every question says so.
 */

/** The state key of the customer's text, wherever Jev reads it. */
export const CUSTOMER_MESSAGE = 'customer_message';

/** Two questions, each in a request of its own: does the message order films? does some of it speak to the system? */
export function jevGuard(jev: Jev, prompts: Prompts['guard']): Guard {
  return {
    async check(text, { signal }) {
      const started = performance.now();
      const state = { [CUSTOMER_MESSAGE]: text };
      const [order, steer] = await decideAll(
        jev,
        [
          { state, questions: [prompts.order] },
          { state, questions: [prompts.steer] },
        ],
        signal,
        started,
      );
      return {
        order: noul(order, prompts.order),
        steer: noul(steer, prompts.steer),
        usage: usage(jev, started, order, steer),
      };
    },
  };
}

/** One choice request per title: a title read beside others would be coloured by them. */
export function jevIdentifier(jev: Jev, prompts: Prompts['identify']): Identifier {
  return {
    async identify(titles, { signal }) {
      const started = performance.now();
      const decisions = await decideAll(
        jev,
        titles.map((title) => ({ state: { film_title: title }, questions: [prompts.film] })),
        signal,
        started,
      );
      const identifications = decisions.map((d) => {
        const { choice, confidence } = answer(d, prompts.film);
        // the pipeline holds the film to the contract; Jev's options are the films
        return { film: choice as Line['film'], confidence };
      });
      return { identifications, usage: usage(jev, started, ...decisions) };
    },
  };
}

/** A question of the judge about one item of a reading. */
interface Probe {
  check: Finding['check'];
  label: string;
  question: Question;
  state: Record<string, string>;
  /** Scores 1 − p: the question hunts a fault, and "yes" is bad. */
  invert?: boolean;
}

/**
 * The judge, as the benches taught it: a short question on one observable
 * fact, one item per request, the worst score decides.
 *
 *     asked     each line      does the customer ask to buy this film?          p
 *     identity  each line      is this title the film it was identified as?     p
 *     missing   whole reading  does the customer ask for a film not listed?     1 − p
 */
export function jevJudge(jev: Jev, prompts: Prompts['judge']): Judge {
  return {
    async judge(text, lines, { signal }): Promise<Answered<{ findings: Finding[] }>> {
      const started = performance.now();
      const probes = judgeProbes(text, lines, prompts);
      const decisions = await decideAll(
        jev,
        probes.map((p): Request => ({ state: p.state, questions: [p.question] })),
        signal,
        started,
      );
      const findings = probes.map((p, i) => {
        const p1 = noul(decisions[i], p.question);
        return { check: p.check, label: p.label, score: p.invert ? 1 - p1 : p1 };
      });
      return { findings, usage: usage(jev, started, ...decisions) };
    },
  };
}

/**
 * What Jev reads, so that every implementation asks the same thing: a title
 * in double quotes, JSON-escaped; for identity, the film it was identified
 * as, in the judge's words; for missing, one line per reading line,
 * `- N × "title"`.
 */
export function judgeProbes(text: string, lines: readonly Line[], prompts: Prompts['judge']): Probe[] {
  const quoted = (l: Line) => JSON.stringify(l.title);
  return [
    ...lines.flatMap((l): Probe[] => [
      {
        check: 'asked',
        label: l.title,
        question: prompts.asked,
        state: { [CUSTOMER_MESSAGE]: text, order_line: quoted(l) },
      },
      {
        check: 'identity',
        label: l.title,
        question: prompts.identity,
        state: { [CUSTOMER_MESSAGE]: text, order_line: `${quoted(l)}, identified as ${prompts.films[l.film]}` },
      },
    ]),
    {
      check: 'missing',
      label: 'the whole reading',
      question: prompts.missing,
      state: { [CUSTOMER_MESSAGE]: text, order_lines: lines.map((l) => `- ${l.quantity} × ${quoted(l)}`).join('\n') },
      invert: true,
    },
  ];
}

/** Jev's decisions; a failure says what the stage took until then: the requests sent, and the answers that came. */
async function decideAll(jev: Jev, requests: Request[], signal: AbortSignal, started: number): Promise<Decision[]> {
  const tally: Tally = { sent: 0, costUsd: 0 };
  try {
    return await jev.decideAll(requests, signal, tally);
  } catch (error) {
    throw engineFailure(error, usageOf(jev, started, tally));
  }
}

function answer(decision: Decision | undefined, question: Question) {
  const a = decision?.answers[question.key];
  if (!a) throw new EngineError(`jev: no answer for ${JSON.stringify(question.key)}`);
  return a;
}

function noul(decision: Decision | undefined, question: Question): number {
  return answer(decision, question).noul;
}

/** What a set of requests took, since `started`, by its tally: the requests sent, whatever became of them. */
function usageOf(jev: Jev, started: number, tally: Tally): EngineUsage {
  return {
    engine: jev.engine,
    model: jev.model,
    calls: tally.sent,
    ms: Math.round(performance.now() - started),
    costUsd: tally.costUsd,
  };
}

/** What a set of decisions took, since `started`. */
function usage(jev: Jev, started: number, ...decisions: (Decision | undefined)[]): EngineUsage {
  return {
    engine: jev.engine,
    model: jev.model,
    calls: decisions.length,
    ms: Math.round(performance.now() - started),
    costUsd: decisions.reduce((total, d) => total + (d?.costUsd ?? 0), 0),
  };
}
