import { llmReader } from '../src/engines/live/reader.ts';
import { Jev } from '../src/engines/live/jev.ts';
import { jevGuard, jevIdentifier, jevJudge } from '../src/engines/live/questions.ts';
import { FILMS, isFilm, type Film, type Mention } from '../src/cart.ts';
import type { Engines } from '../src/pipeline/ports.ts';
import type { Prompts } from '../src/prompts.ts';
import type { Case } from './cases.ts';
import { newSubject, type Setup, type SubjectName } from './subjects.ts';

/**
 * What one pass over a subject's cases would send: the model calls, and the tokens of their input. Jev's tokenizer
 * is not published: the tokens are counted with the one the service counts carts with.
 */
export interface Estimate {
  /** What the run would test. */
  variant: string;
  /** The calls to Jev and to the LLMs. */
  jev: number;
  llm: number;
  /** The input of all calls, and of each kind; `outputTokens` is what the readings would answer: the expected reading in JSON, reasoning tokens not counted. */
  tokens: number;
  jevTokens: number;
  llmTokens: number;
  outputTokens: number;
  /**
   * The count rests on the cases rather than on what the models will answer: the parse and the recount decide
   * how many titles are identified and judged, and a reading the judge refuses is read again, up to `readAttempts` times.
   */
  approximate: boolean;
  /** How many readings a refused cart may take, for the subject that reads again (reading); the count is for one. */
  readAttempts: number;
}

/**
 * Plays each case once through the subject's own code, on engines that call nothing: the real engines, with the
 * real prompts, behind a network that only counts what is sent. Jev answers each question with its first option, or
 * yes; the parse and the recount read one title per film the case expects, or the case's own lines. It counts what
 * a pass would send, each cart read once: the judge's yes to missing would otherwise refuse every reading, and
 * read it again.
 */
export async function dryRun(
  name: SubjectName,
  setup: Omit<Setup, 'engines'>,
  prompts: Prompts,
  cases: readonly Case[],
  count: (text: string) => number,
): Promise<Estimate> {
  const tally = { jev: 0, jevTokens: 0, llm: 0, llmTokens: 0, output: 0 };
  let expected: Mention[] = [];

  const jev = new Jev({
    key: 'dry-run',
    fetch: (_url, init) => {
      const body = bodyOf(init);
      tally.jev++;
      tally.jevTokens += count(body);
      const { questions } = JSON.parse(body) as {
        questions: Record<string, { type: string; criteria: Record<string, string> }>;
      };
      const answers = Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          q.type === 'choice'
            ? { choice: Object.keys(q.criteria).toSorted()[0], confidence: 1 }
            : { noul: 1, confidence: 1 },
        ]),
      );
      return Promise.resolve(Response.json({ id: 'dry-run', answers, usage: { cost: 0 } }));
    },
  });
  const reader = () =>
    llmReader(prompts.parse, {
      key: 'dry-run',
      model: 'dry-run',
      effort: 'none',
      fetch: (_url, init) => {
        const { messages } = JSON.parse(bodyOf(init)) as { messages: { content: string }[] };
        tally.llm++;
        tally.llmTokens += messages.reduce((total, m) => total + count(m.content), 0);
        const content = JSON.stringify({ films: expected.map(({ title, quantity }) => ({ title, quantity })) });
        tally.output += count(content);
        return Promise.resolve(
          Response.json({
            id: 'dry-run',
            object: 'chat.completion',
            created: 0,
            model: 'dry-run',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      },
    });
  const engines: Engines = {
    name: 'live',
    guard: jevGuard(jev, prompts.guard),
    parser: reader(),
    recounter: reader(),
    identifier: jevIdentifier(jev, prompts.identify),
    judge: jevJudge(jev, prompts.judge),
  };

  const tested = newSubject(name, { ...setup, engines }); // what a run would test, its variant
  const subject = newSubject(name, { ...setup, engines, readAttempts: 1 });
  for (const c of cases) {
    expected = expectedReading(c);
    const played = await subject.play(c.input);
    if (played.error) throw played.error;
  }
  const llmTokens = tally.llmTokens;
  return {
    variant: tested.variant,
    jev: tally.jev,
    llm: tally.llm,
    tokens: tally.jevTokens + llmTokens,
    jevTokens: tally.jevTokens,
    llmTokens,
    outputTokens: tally.output,
    approximate: tally.llm > 0,
    readAttempts: name === 'reading' ? Math.max(tested.readAttempts ?? 1, 1) : 0,
  };
}

/** What the readers would answer: one title per film the case expects (reading), or the lines the case gives (judge). */
function expectedReading(c: Case): Mention[] {
  const films = (c.expect as { films?: Record<string, number> } | undefined)?.films ?? {};
  const lines = (c.input as { lines?: Mention[] } | undefined)?.lines ?? [];
  return [
    ...FILMS.flatMap((film: Film) => {
      const quantity = films[film];
      return isFilm(film) && quantity !== undefined && quantity > 0 ? [{ title: film, quantity }] : [];
    }),
    ...lines.map(({ title, quantity }) => ({ title, quantity })),
  ];
}

/** The text of a request the engines send: they all send JSON. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}
