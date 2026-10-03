import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Line } from '../src/cart.ts';
import { loadConfig } from '../src/config.ts';
import { liveEngines } from '../src/engines/live/index.ts';
import { retryTurn } from '../src/engines/live/reader.ts';
import { EngineError } from '../src/pipeline/ports.ts';
import { loadPrompts } from '../src/prompts.ts';

// The live engines against stand-ins of OpenRouter: what each stage sends,
// and how it reads the answers. No test reaches the network.

// a fixture prompt set: the assembly is tested, the words live in prompts/ only
const prompts = loadPrompts(fileURLToPath(new URL('fixtures/prompts/', import.meta.url)));
const config = loadConfig({ OPENROUTER_API_KEY: 'k' }).live;
const call = { signal: new AbortController().signal };

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch whose answer `answer` makes of what it was sent, and that keeps it. */
function openRouter(answer: (sent: Sent) => [number, unknown], live = config) {
  const sent: Sent[] = [];
  const fetch = (url: string | URL, init?: RequestInit) => {
    const request = { url: String(url), body: JSON.parse(init?.body as string) as Record<string, unknown> };
    sent.push(request);
    const [status, body] = answer(request);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  };
  return { sent, engines: liveEngines(live, prompts, fetch as typeof globalThis.fetch) };
}

type Decisions = { state: Record<string, string>; questions: Record<string, { type: string; instructions: string }> };

/** Jev answering each question key with `answer(state, key)`. */
function jev(answer: (state: Record<string, string>, key: string) => Record<string, unknown>) {
  return openRouter(({ body }) => {
    const { state, questions } = body as Decisions;
    const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, answer(state, key)]));
    return [200, { id: 'd', answers, usage: { cost: 0.0001, input_tokens: 300, output_tokens: 2 } }];
  });
}

describe('live guard', () => {
  it('puts order and steer, each in a request of its own, about the customer message', async () => {
    const { sent, engines } = jev((_, key) => ({ noul: key === 'order' ? 0.9 : 0.05 }));
    const answers = await engines.guard.check('Back to the Future 1', call);
    expect(answers).toMatchObject({ order: 0.9, steer: 0.05 });
    expect(answers.usage).toMatchObject({ engine: 'jev-1.13', model: 'typesafe/jev-1.13', calls: 2, costUsd: 0.0002 });
    expect(sent.map((s) => s.url)).toEqual(Array(2).fill('https://openrouter.ai/api/alpha/decisions'));
    const bodies = sent.map((s) => s.body as Decisions);
    expect(bodies.map((b) => Object.keys(b.questions))).toEqual([['order'], ['steer']]);
    for (const b of bodies) expect(b.state).toEqual({ customer_message: 'Back to the Future 1' });
    expect(bodies[0]?.questions.order?.instructions).toBe(prompts.guard.order.instructions);
  });
});

describe('live identifier', () => {
  it('asks one choice per title, in parallel, and answers in the order of the titles', async () => {
    const { sent, engines } = jev((state) => ({
      choice: state.film_title === 'Retour vers le futur 2' ? 'bttf_2' : 'other',
      confidence: 0.93,
    }));
    const { identifications, usage } = await engines.identifier.identify(['Retour vers le futur 2', 'Heat'], call);
    expect(identifications).toEqual([
      { film: 'bttf_2', confidence: 0.93 },
      { film: 'other', confidence: 0.93 },
    ]);
    expect(usage.calls).toBe(2);
    expect(sent.map((s) => (s.body as Decisions).state)).toEqual([
      { film_title: 'Retour vers le futur 2' },
      { film_title: 'Heat' },
    ]);
    expect(sent.map((s) => Object.keys((s.body as Decisions).questions))).toEqual([['film'], ['film']]);
  });
});

describe('live judge', () => {
  const lines: Line[] = [
    { title: 'Retour vers le futur 2', quantity: 2, film: 'bttf_2', confidence: 1 },
    { title: 'Le "Grand" Bleu', quantity: 1, film: 'other', confidence: 1 },
  ];

  it('asks asked and identity per line, then missing, each in a request of its own, as the doc writes them', async () => {
    const { sent, engines } = jev(() => ({ noul: 0.9 }));
    await engines.judge.judge('the text', lines, call);
    expect(sent.map((s) => (s.body as Decisions).state)).toEqual([
      { customer_message: 'the text', order_line: '"Retour vers le futur 2"' },
      {
        customer_message: 'the text',
        order_line: '"Retour vers le futur 2", identified as film two',
      },
      { customer_message: 'the text', order_line: '"Le \\"Grand\\" Bleu"' },
      {
        customer_message: 'the text',
        order_line: '"Le \\"Grand\\" Bleu", identified as another film',
      },
      { customer_message: 'the text', order_lines: '- 2 × "Retour vers le futur 2"\n- 1 × "Le \\"Grand\\" Bleu"' },
    ]);
    expect(sent.map((s) => Object.keys((s.body as Decisions).questions)[0])).toEqual([
      'asked',
      'identity',
      'asked',
      'identity',
      'missing',
    ]);
  });

  it('scores asked and identity p, missing 1 − p: it hunts a fault', async () => {
    const { engines } = jev((state, key) => ({
      noul: key === 'missing' ? 0.8 : state.order_line?.includes('Grand') ? 0.3 : 0.9,
    }));
    const { findings, usage } = await engines.judge.judge('the text', lines, call);
    expect(findings.map((f) => [f.check, f.label, Number(f.score.toFixed(2))])).toEqual([
      ['asked', 'Retour vers le futur 2', 0.9],
      ['identity', 'Retour vers le futur 2', 0.9],
      ['asked', 'Le "Grand" Bleu', 0.3],
      ['identity', 'Le "Grand" Bleu', 0.3],
      ['missing', 'the whole reading', 0.2],
    ]);
    expect(usage).toMatchObject({ calls: 5, costUsd: expect.closeTo(0.0005) as number });
  });

  it('fails as an engine when Jev does, saying it made no call that counts', async () => {
    const { engines } = openRouter(() => [402, { error: { message: 'insufficient credits' } }]);
    const error = await engines.judge.judge('the text', lines, call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).usage).toMatchObject({ engine: 'jev-1.13', calls: 0, costUsd: 0 });
  });
});

describe('live readers', () => {
  /** A chat completion whose message is `content`. */
  const completion = (content: string, extra: Record<string, unknown> = {}) => ({
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'openai/gpt-6-luna',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
    usage: { prompt_tokens: 812, completion_tokens: 40, total_tokens: 852, cost: 0.00031 },
    ...extra,
  });

  it('asks the parse model for a strict JSON schema, the message fenced, the cost reported', async () => {
    const { sent, engines } = openRouter(() => [200, completion('{"films":[{"title":"Heat","quantity":2}]}')]);
    const { mentions, usage } = await engines.parser.read('2 x Heat', call);
    expect(mentions).toEqual([{ title: 'Heat', quantity: 2 }]);
    expect(usage).toMatchObject({
      engine: 'openai/gpt-6-luna',
      model: 'openai/gpt-6-luna',
      calls: 1,
      costUsd: 0.00031,
    });
    const [{ url, body }] = sent as [Sent];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body).toMatchObject({
      model: 'openai/gpt-6-luna',
      messages: [
        { role: 'system', content: prompts.parse.instruction },
        { role: 'user', content: '<m>2 x Heat</m>' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'reading', strict: true, schema: prompts.parse.schema },
      },
      reasoning_effort: 'minimal',
      max_completion_tokens: 4096,
      usage: { include: true },
    });
    // every word put to the model is prompts/parse.json's: the schema rides alone, without a description
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'reading', strict: true, schema: prompts.parse.schema },
    });
  });

  it('reads again as the conversation going on: its last reading as its answer, then what failed, one line per check', async () => {
    const { sent, engines } = openRouter(() => [200, completion('{"films":[{"title":"Heat","quantity":2}]}')]);
    const retry = {
      previous: [{ title: 'Heat <3', quantity: 1 }],
      failed: [
        { check: 'missing' as const, label: 'the whole reading', score: 0.1 },
        { check: 'count' as const, label: 'other: 1 read, 2 recounted', score: 0 },
      ],
    };
    await engines.parser.read('2 x Heat <3', call, retry);
    const { meanings } = prompts.parse.retry;
    expect(sent[0]?.body.messages).toEqual([
      { role: 'system', content: prompts.parse.instruction },
      { role: 'user', content: '<m>2 x Heat <3</m>' },
      { role: 'assistant', content: '{"films":[{"title":"Heat <3","quantity":1}]}' },
      {
        role: 'user',
        content: prompts.parse.retry.turn.replace(
          '{findings}',
          `* missing [the whole reading] ${meanings.missing}\n* count [other: 1 read, 2 recounted] ${meanings.count}`,
        ),
      },
    ]);
  });

  it('fills the placeholders in one pass: a title holding {meaning} stays as written', () => {
    const turn = retryTurn(prompts.parse.retry, [{ check: 'asked', label: 'The {meaning} of {check}', score: 0 }]);
    expect(turn).toContain(`* asked [The {meaning} of {check}] ${prompts.parse.retry.meanings.asked}`);
  });

  it('writes a $ in a title as it is in the retry turn', () => {
    const turn = retryTurn(prompts.parse.retry, [{ check: 'asked', label: "$& $' $1", score: 0 }]);
    expect(turn).toContain(`* asked [$& $' $1] ${prompts.parse.retry.meanings.asked}`);
  });

  it('sends no reasoning field at effort none, and reads from the base URL it is given', async () => {
    const local = { ...config, parseEffort: 'none', parseBaseUrl: 'http://localhost:11434/v1' };
    const { sent, engines } = openRouter(() => [200, completion('{"films":[]}')], local);
    await engines.parser.read('Heat', call);
    expect(sent[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(sent[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('reads each line with its film when the parse identifies, and sends them back so on a retry', async () => {
    const identifies = { ...config, parseIdentifies: true };
    const { sent, engines } = openRouter(
      () => [200, completion('{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}]}')],
      identifies,
    );
    const retry = { previous: [{ title: 'BTTF 2', quantity: 2, film: 'bttf_2' as const }], failed: [] };
    const { mentions } = await engines.parser.read('BTTF 2', call, retry);
    expect(mentions).toEqual([{ title: 'BTTF 2', quantity: 1, film: 'bttf_2' }]);
    expect(sent[0]?.body).toMatchObject({
      messages: [
        { content: prompts.parseFilms.instruction },
        {},
        { role: 'assistant', content: '{"films":[{"title":"BTTF 2","quantity":2,"film":"bttf_2"}]}' },
        {},
      ],
      response_format: { json_schema: { schema: prompts.parseFilms.schema } },
    });
  });

  it('holds a film out of the enum off schema', async () => {
    const { engines } = openRouter(
      () => [200, completion('{"films":[{"title":"Heat","quantity":1,"film":"bttf_4"}]}')],
      { ...config, parseIdentifies: true },
    );
    await expect(engines.parser.read('Heat', call)).rejects.toBeInstanceOf(EngineError);
  });

  it('asks the recount of its own model, with the same instruction and schema', async () => {
    const { sent, engines } = openRouter(() => [200, completion('{"films":[]}')]);
    await expect(engines.recounter.read('Heat', call)).resolves.toMatchObject({
      mentions: [],
      usage: { engine: 'deepseek/deepseek-v4.1-flash' },
    });
    expect(sent[0]?.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ content: prompts.parse.instruction }, {}],
      response_format: { json_schema: { schema: prompts.parse.schema } },
    });
  });

  it.each([
    ['text around the JSON', 'Here: {"films":[]}'],
    ['no films', '{"reading":[]}'],
    ['a field the schema does not have', '{"films":[{"title":"Heat","quantity":1,"price":0}]}'],
    ['a quantity under 1', '{"films":[{"title":"Heat","quantity":0}]}'],
    ['a quantity that is not an integer', '{"films":[{"title":"Heat","quantity":1.5}]}'],
    ['a blank title', '{"films":[{"title":"  ","quantity":1}]}'],
  ])('holds an answer with %s off schema: an engine failure, its call counted', async (_, content) => {
    const { engines } = openRouter(() => [200, completion(content)]);
    const error = await engines.parser.read('Heat', call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).usage).toMatchObject({ calls: 1, costUsd: 0.00031 });
  });

  it('holds an answer cut short a failure', async () => {
    const cut = completion('{"films":[{"title":"He', {
      choices: [
        { index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"films":[{"title":"He' } },
      ],
    });
    const { engines } = openRouter(() => [200, cut]);
    await expect(engines.parser.read('Heat', call)).rejects.toThrow('cut short');
  });

  it('fails at once on an error status: no retry where a customer waits', async () => {
    const { sent, engines } = openRouter(() => [429, { error: { message: 'rate limited', code: 429 } }]);
    const error = await engines.parser.read('Heat', call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).usage).toMatchObject({ calls: 0, costUsd: 0 });
    expect(sent).toHaveLength(1);
  });
});
