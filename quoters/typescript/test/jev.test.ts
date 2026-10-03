import { describe, expect, it } from 'vitest';
import { Jev, JevError, JEV_MODEL, type Request } from '../src/engines/live/jev.ts';
import type { Question } from '../src/prompts.ts';

// Jev's wire protocol, against a stand-in of OpenRouter's decisions
// endpoint: no test reaches the network.

const film: Question = {
  key: 'film',
  kind: 'choice',
  instructions: 'Which film?',
  criteria: { bttf_1: 'the first', other: 'another' },
};
const yes: Question = {
  key: 'yes',
  kind: 'noul',
  instructions: 'Is it?',
  criteria: { true: 'it is', false: 'it is not' },
};

interface Sent {
  url: string;
  headers: Headers;
  body: { model: string; state: Record<string, string>; questions: Record<string, unknown> };
}

/** A fetch that answers each call with the next of `answers` (the last one repeats), and keeps what it was sent. */
function stub(...answers: [number, string][]) {
  const sent: Sent[] = [];
  const fetch = (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body as string) as Sent['body'],
    });
    const [status, body] = answers[Math.min(sent.length, answers.length) - 1] ?? [500, ''];
    return Promise.resolve(new Response(body, { status }));
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

const never = new AbortController().signal;
const request: Request = { state: { film_title: 'Retour vers le futur' }, questions: [film, yes] };

describe('Jev.decide', () => {
  it('speaks the decisions protocol: its model, its key, the state, the questions by key', async () => {
    const { sent, fetch } = stub([
      200,
      JSON.stringify({
        id: 'd1',
        answers: {
          film: { choice: 'bttf_1', confidence: 0.8, probabilities: { bttf_1: 0.8, other: 0.2 } },
          yes: { noul: 0.7 },
        },
        usage: { cost: 0.00004 },
      }),
    ]);
    const decision = await new Jev({ key: 'k', fetch }).decide(request, never);
    expect(decision).toMatchObject({
      id: 'd1',
      costUsd: 0.00004,
      answers: {
        film: { choice: 'bttf_1', confidence: 0.8, probabilities: { bttf_1: 0.8, other: 0.2 } },
        yes: { noul: 0.7 },
      },
    });
    const [{ url, headers, body }] = sent as [Sent];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('x-title')).toBe('delorean');
    expect(headers.get('content-type')).toBe('application/json');
    expect(Object.keys(body)).toEqual(['model', 'questions', 'state']);
    expect(Object.keys(body.questions.yes as object)).toEqual(['criteria', 'instructions', 'type']);
    expect(Object.keys((body.questions.yes as { criteria: object }).criteria)).toEqual(['false', 'true']);
    expect(body).toEqual({
      model: JEV_MODEL,
      state: { film_title: 'Retour vers le futur' },
      questions: {
        film: { type: 'choice', instructions: 'Which film?', criteria: { bttf_1: 'the first', other: 'another' } },
        yes: { type: 'noul', instructions: 'Is it?', criteria: { true: 'it is', false: 'it is not' } },
      },
    });
  });

  it('names its engine after its pinned model', () => {
    expect(new Jev({ key: 'k' }).engine).toBe('jev-1.13');
    const jev = new Jev({ key: 'k', model: 'typesafe/jev-2.0' });
    expect([jev.model, jev.engine]).toEqual(['typesafe/jev-2.0', 'jev-2.0']);
  });

  it.each([
    ['input_tokens', '{"cost":0.00003,"input_tokens":312,"output_tokens":5}', 312, 5],
    ['prompt_tokens', '{"cost":0.00003,"prompt_tokens":298,"completion_tokens":4}', 298, 4],
    ['no count', '{"cost":0.00003}', 0, 0],
  ])('keeps the tokens under either spelling: %s', async (_, usage, input, output) => {
    const { fetch } = stub([
      200,
      `{"id":"d1","answers":{"film":{"choice":"other","confidence":0.9}},"usage":${usage}}`,
    ]);
    const decision = await new Jev({ key: 'k', fetch }).decide({ state: {}, questions: [film] }, never);
    expect([decision.inputTokens, decision.outputTokens, decision.costUsd]).toEqual([input, output, 0.00003]);
  });

  it.each([
    ['an option the question does not have', '{"answers":{"film":{"choice":"bttf_4"}}}'],
    ['a question left unanswered', '{"answers":{}}'],
    ['an answer that is not an object', '{"answers":{"film":"bttf_1"}}'],
    ['a probability over 1', '{"answers":{"film":{"choice":"other","confidence":1.3}}}'],
    ['a probability that is not a number', '{"answers":{"film":{"choice":"other","confidence":"high"}}}'],
  ])('refuses %s: an engine that drifts is an error, not a verdict', async (_, body) => {
    const { fetch } = stub([200, body]);
    await expect(new Jev({ key: 'k', fetch }).decide({ state: {}, questions: [film] }, never)).rejects.toBeInstanceOf(
      JevError,
    );
  });

  it.each([
    [429, '{"error":{"message":"slow down"}}', 'jev-1.13: status 429: slow down', true],
    [402, '{"error":{"message":"insufficient credits"}}', 'jev-1.13: status 402: insufficient credits', false],
    [529, '{"error":{"message":"overloaded"}}', 'jev-1.13: status 529: overloaded', true],
    [502, '<html>bad gateway</html>', 'jev-1.13: status 502: bad JSON: <html>bad gateway</html>', true],
    [200, 'null', 'jev-1.13: status 200: not a decision: null', false],
  ])('fails on status %i, saying the status and the message', async (status, body, message, transient) => {
    const { fetch } = stub([status, body]);
    const error = await new Jev({ key: 'k', fetch }).decide(request, never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).message).toBe(message);
    expect((error as JevError).transient).toBe(transient);
  });

  it('retries nothing by default: a customer waits', async () => {
    const { sent, fetch } = stub(
      [429, '{"error":{"message":"slow down"}}'],
      [200, '{"answers":{"film":{"choice":"other"}}}'],
    );
    await expect(new Jev({ key: 'k', fetch }).decide({ state: {}, questions: [film] }, never)).rejects.toThrow(
      'status 429',
    );
    expect(sent).toHaveLength(1);
  });

  it('waits out a transient failure when told to, and not a lasting one', async () => {
    const answered = '{"answers":{"film":{"choice":"other"}}}';
    const transient = stub([503, '{"error":{"message":"reset"}}'], [200, answered]);
    const jev = new Jev({ key: 'k', fetch: transient.fetch, attempts: 3, retryWaitMs: 1 });
    await expect(jev.decide({ state: {}, questions: [film] }, never)).resolves.toBeDefined();
    expect(transient.sent).toHaveLength(2);

    const lasting = stub([402, '{"error":{"message":"insufficient credits"}}']);
    const refused = new Jev({ key: 'k', fetch: lasting.fetch, attempts: 3, retryWaitMs: 1 });
    await expect(refused.decide({ state: {}, questions: [film] }, never)).rejects.toThrow('402');
    expect(lasting.sent).toHaveLength(1);
  });

  it('gives up when the request is cancelled', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof globalThis.fetch;
    const error = await new Jev({ key: 'k', fetch }).decide(request, AbortSignal.timeout(5)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as Error).message).toBe('jev-1.13: cancelled');
  });
});

describe('Jev.decideAll', () => {
  const answer = (choice: string) =>
    `{"answers":{"film":{"choice":"${choice}","confidence":1}},"usage":{"cost":0.001}}`;

  it('answers in the order of the requests, each in a call of its own, at most 16 at once', async () => {
    let open = 0;
    let most = 0;
    const fetch = (async (_url: string, init?: RequestInit) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open--;
      const { state } = JSON.parse(init?.body as string) as Sent['body'];
      return new Response(answer(state.film_title === 'first' ? 'bttf_1' : 'other'));
    }) as typeof globalThis.fetch;
    const requests = Array.from({ length: 40 }, (_, i): Request => ({
      state: { film_title: i === 0 ? 'first' : `title ${i}` },
      questions: [film],
    }));
    const decisions = await new Jev({ key: 'k', fetch }).decideAll(requests, never);
    expect(decisions).toHaveLength(40);
    expect(decisions.map((d) => d.answers.film?.choice)).toEqual(['bttf_1', ...Array<string>(39).fill('other')]);
    expect(most).toBe(16);
  });

  it('fails the whole set on the first failure, and stops the calls still to come', async () => {
    const { sent, fetch } = stub([200, answer('other')], [402, '{"error":{"message":"insufficient credits"}}']);
    const requests = Array.from({ length: 40 }, (): Request => ({ state: {}, questions: [film] }));
    await expect(new Jev({ key: 'k', fetch }).decideAll(requests, never)).rejects.toThrow('insufficient credits');
    expect(sent.length).toBeLessThan(40);
  });

  it('asks nothing of no request', async () => {
    const { sent, fetch } = stub();
    await expect(new Jev({ key: 'k', fetch }).decideAll([], never)).resolves.toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
