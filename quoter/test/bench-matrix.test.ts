import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describedRow, estimatedRow, fetchPrices, loadVariants, rowOf, table, type Row } from '../bench/matrix.ts';
import { run } from '../bench/run.ts';
import { newSubject } from '../bench/subjects.ts';
import type { Engines } from '../src/pipeline/ports.ts';
import { free } from './support.ts';
import { files, setup } from './bench-support.ts';

const VARIANTS = new URL('../bench/variants.yaml', import.meta.url).pathname;

describe('the variants file', () => {
  it('is the parser variants of the benches, each name unique and each a set of environment overrides', () => {
    const variants = loadVariants(VARIANTS);
    expect(variants.map((v) => v.name)).toEqual([
      'luna-low',
      'luna-minimal',
      'luna-none',
      'luna-pro-low',
      'gemini-3.1-flash-lite',
      'deepseek-v4.1-flash',
      'schematron-v2-small',
      'nex-n2.5-mini',
      'local-llama3.2-3b',
      'local-qwen2.5-14b',
    ]);
    expect(variants.find((v) => v.name === 'luna-minimal')).toEqual({
      name: 'luna-minimal',
      note: 'the default since the bench (135/138, as low, p50 1.17 s against 1.21 s)',
      env: { PARSE_MODEL: 'openai/gpt-6-luna', PARSE_EFFORT: 'minimal' },
    });
    expect(variants.find((v) => v.name === 'local-llama3.2-3b')?.env).toEqual({
      PARSE_MODEL: 'llama3.2:3b',
      PARSE_EFFORT: 'none',
      PARSE_BASE_URL: 'http://localhost:11434/v1',
    });
  });

  it.each([
    ['no variant', 'variants: []\n', 'no variant'],
    ['a name that is not a file name', 'variants:\n  - name: Luna Low\n    env: {}\n', 'name "Luna Low"'],
    ['a name twice', 'variants:\n  - { name: a, env: {} }\n  - { name: a, env: {} }\n', 'variant "a" twice'],
    ['a field no variant has', 'variants:\n  - { name: a, env: {}, model: x }\n', 'unknown field model'],
    [
      'an environment value that is not a string',
      'variants:\n  - { name: a, env: { PARSE_EFFORT: 3 } }\n',
      'PARSE_EFFORT must be a string',
    ],
    ['another top-level key', 'variants:\n  - { name: a, env: {} }\nextra: 1\n', 'a file of {variants'],
  ])('refuses %s', (_what, text, message) => {
    const dir = files({ 'variants.yaml': text });
    expect(() => loadVariants(join(dir, 'variants.yaml'))).toThrow(message);
  });
});

const row = (changes: Partial<Row> = {}): Row => ({
  ...describedRow({
    variant: 'luna-low',
    model: 'gpt-6-luna',
    effort: 'low',
    strategy: 'parse + identify',
    local: false,
  }),
  ...changes,
});

describe('the table', () => {
  it('compares the variants measured: accuracy, cases failed, the parse’s latency, the cost of a cart', () => {
    const text = table([
      row({
        passed: 135,
        scored: 138,
        cases_failed: 3,
        p50_ms: 1170,
        p90_ms: 2500,
        cost_per_cart_usd: 0.000169,
        errors: 1,
      }),
      row({
        variant: 'local-llama3.2-3b',
        model: 'llama3.2:3b',
        effort: 'none',
        local: true,
        passed: 100,
        scored: 138,
        cut_short: true,
      }),
      row({ variant: 'later' }),
    ]);
    expect(text).toBe(
      [
        '| variant | model | effort | strategy | accuracy | cases failed | p50 | p90 | cost / cart | cost / 1,000 carts | errors |',
        '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
        '| luna-low | gpt-6-luna | low | parse + identify | 135 / 138 (98 %) | 3 | 1170 ms | 2500 ms | $0.000169 | $0.169 | 1 |',
        '| local-llama3.2-3b | llama3.2:3b (local) | none | parse + identify | 100 / 138 (72 %) — cut short | 0 | 0 ms | 0 ms | $0.000000 | $0.000 | 0 |',
        '| later | gpt-6-luna | low | parse + identify | — | 0 | 0 ms | 0 ms | $0.000000 | $0.000 | 0 |',
        '',
      ].join('\n'),
    );
  });

  it('compares the variants estimated: calls and cost, nothing measured', () => {
    const estimate = {
      variant: 'v',
      jev: 6,
      llm: 4,
      tokens: 0,
      jevTokens: 0,
      llmTokens: 2000,
      outputTokens: 400,
      approximate: true,
      readAttempts: 0,
    };
    const priced = estimatedRow(row(), estimate, 2, { prompt: 1e-6, completion: 4e-6, structuredOutputs: true });
    // (2000 × 1e-6 + 400 × 4e-6 + 6 × 3e-5) / 2 carts
    expect(priced).toMatchObject({ estimated: true, llm_calls_per_cart: 2, jev_calls_per_cart: 3 });
    expect(priced.cost_per_cart_usd).toBeCloseTo((0.002 + 0.0016 + 0.00018) / 2, 9);
    const free = estimatedRow(row({ local: true, model: 'llama3.2:3b' }), estimate, 2, {
      prompt: 1,
      completion: 1,
      structuredOutputs: true,
    });
    expect(free.cost_per_cart_usd).toBeCloseTo(0.00009, 9);
    expect(table([priced])).toContain(
      '| variant | model | effort | strategy | LLM calls / cart | Jev calls / cart | ≈ cost / cart | ≈ cost / 1,000 carts |',
    );
    expect(table([priced])).toContain(
      '| luna-low | gpt-6-luna | low | parse + identify | 2.0 | 3.0 | $0.001890 | $1.890 |',
    );
  });
});

describe('rowOf', () => {
  it('reads a run’s report into a row: the first metric over every case and run, the parse’s latency, the cost a cart', async () => {
    const paid: Engines['parser'] = {
      read: async (text, call) => ({
        ...(await setup().engines.parser.read(text, call)),
        usage: { ...free, costUsd: 0.002, ms: 1000 },
      }),
    };
    const subject = newSubject('parse', setup({ parser: paid }));
    const cases = [
      { id: 'a', note: 'n', input: { text: 'Back to the Future 1' }, expect: { films: { bttf_1: 1 } } },
      { id: 'b', note: 'n', input: { text: 'Back to the Future 2' }, expect: { films: { bttf_1: 1 } } },
    ];
    const report = await run(subject, cases, { runs: 2 });
    const out = rowOf(row(), report, subject.stats.summary());
    expect(out).toMatchObject({ passed: 2, scored: 4, cases_failed: 1, p50_ms: 1000, p90_ms: 1000, errors: 0 });
    expect(out.cost_per_cart_usd).toBeCloseTo(0.002);
    expect(out.cut_short).toBeUndefined();
  });
});

describe('fetchPrices', () => {
  it('reads OpenRouter’s models API: the price of a token and the support of structured outputs', async () => {
    const fetch = () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: 'a/b',
              pricing: { prompt: '0.000001', completion: '0.000004' },
              supported_parameters: ['structured_outputs'],
            },
            { id: 'c/d', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          ],
        }),
      );
    const prices = await fetchPrices('https://models.example', fetch);
    expect(prices.get('a/b')).toEqual({ prompt: 1e-6, completion: 4e-6, structuredOutputs: true });
    expect(prices.get('c/d')).toEqual({ prompt: 0, completion: 0, structuredOutputs: false });
  });

  it('says the API’s status when it fails', async () => {
    await expect(
      fetchPrices('https://models.example', () => Promise.resolve(new Response('', { status: 503 }))),
    ).rejects.toThrow('models API: status 503');
  });
});
