import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Case } from '../bench/cases.ts';
import { dryRun } from '../bench/dryrun.ts';
import { setupOf } from '../bench/setup.ts';
import { config, prompts } from './bench-support.ts';
import { counter } from './support.ts';

const count = (text: string) => counter.count(text);

/** What a dry run counts, on the service's default configuration. */
const dry = (name: Parameters<typeof dryRun>[0], cases: Case[], changes = {}) =>
  dryRun(name, { ...setupOf(config, prompts), ...changes }, prompts, cases, count);

const c = (input: unknown, expect: unknown): Case => ({ id: 'x', note: 'n', input, expect });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the dry run', () => {
  it('sends nothing: no network is touched', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('the network was touched')));
    vi.stubGlobal('fetch', fetch);
    await dry('reading', [c({ text: 'Back to the Future 1' }, { films: { bttf_1: 1 } })]);
    await dry('guard', [c({ text: 'Back to the Future 1' }, { verdict: 'valid' })]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts the guard’s two questions a case, and no LLM', async () => {
    const cases = [
      c({ text: 'Back to the Future 1' }, { verdict: 'valid' }),
      c({ text: 'bonjour' }, { verdict: 'invalid' }),
    ];
    const estimate = await dry('guard', cases);
    expect(estimate).toMatchObject({ jev: 4, llm: 0, approximate: false, readAttempts: 0 });
    expect(estimate.tokens).toBe(estimate.jevTokens);
    expect(estimate.jevTokens).toBeGreaterThan(400);
    expect(estimate.variant).toMatch(/^jev-1\.13 · guard /);
  });

  it('counts one identification a title', async () => {
    const estimate = await dry('identify', [c({ title: 'Retour vers le futur 2' }, { film: 'bttf_2' })]);
    expect(estimate).toMatchObject({ jev: 1, llm: 0 });
  });

  it('counts a reading as one parse and one recount, the films identified once, and the judge’s questions', async () => {
    const estimate = await dry('reading', [
      c({ text: 'Back to the Future 1 and 2' }, { films: { bttf_1: 1, bttf_2: 1 } }),
    ]);
    // 2 titles identified; the judge asks asked and identity of each of 2 lines, then missing
    expect(estimate).toMatchObject({ llm: 2, jev: 2 + 5, approximate: true, readAttempts: 3 });
    expect(estimate.llmTokens).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBeGreaterThan(0);
    expect(estimate.tokens).toBe(estimate.jevTokens + estimate.llmTokens);
  });

  it('counts one reading a case, though the judge’s yes to missing would refuse it and read it again', async () => {
    const once = await dry('reading', [c({ text: 't' }, { films: { bttf_1: 1 } })]);
    expect(once.llm).toBe(2);
  });

  it('counts a text with no film as two readings and no Jev', async () => {
    const estimate = await dry('reading', [c({ text: 'bonjour' }, { films: {} })]);
    expect(estimate).toMatchObject({ llm: 2, jev: 0 });
  });

  it('counts the parse alone for the parse bench: no recount, no judge', async () => {
    const estimate = await dry('parse', [c({ text: 'Back to the Future 1' }, { films: { bttf_1: 1 } })]);
    expect(estimate).toMatchObject({ llm: 1, jev: 1 });
  });

  it('counts the judge bench: the recount, its titles identified, the judge’s questions on the case’s lines', async () => {
    const lines = [
      { title: 'Back to the Future 1', quantity: 1, film: 'bttf_1' },
      { title: 'La chèvre', quantity: 1, film: 'other' },
    ];
    const estimate = await dry('judge', [c({ text: 'both', lines }, { faithful: true })]);
    // the recount reads the lines' titles (2 identifications), the judge puts 2 × 2 + 1 questions
    expect(estimate).toMatchObject({ llm: 1, jev: 2 + 5 });
  });

  it('grows with the cases, not with the engines: the same cases count the same', async () => {
    const cases = [c({ text: 'Back to the Future 1' }, { films: { bttf_1: 1 } })];
    expect(await dry('reading', cases)).toEqual(await dry('reading', cases));
  });
});
