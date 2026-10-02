import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadQuoteCases, selectCases, type QuoteCase } from '../src/cases.ts';
import { REJECTED_BY } from '../src/contract.ts';
import { totalOf } from './support/rules.ts';

const cases = loadQuoteCases();
const priced = cases.flatMap(({ id, expect }) => ('code' in expect ? [] : [{ id, expect }]));
const refused = cases.flatMap(({ id, expect }) => ('code' in expect ? [{ id, expect }] : []));

describe('cases/quote', () => {
  it('holds the five examples of the brief and the cases of the fake engines', () => {
    expect(cases.filter((c) => c.tags.includes('enonce')).map((c) => c.id)).toEqual([
      'enonce-1',
      'enonce-2',
      'enonce-3',
      'enonce-4',
      'enonce-5',
    ]);
    expect(selectCases(cases, 'fake').length).toBeGreaterThanOrEqual(13);
  });

  it.each(priced)('$id: lists its films, and its total follows from them', ({ expect: expected }) => {
    expect(expected.films).toBeDefined();
    expect(totalOf(expected.films ?? {})).toBe(expected.total_cents);
  });

  it.each(refused)('$id: expects a refusal some stage gives', ({ expect: expected }) => {
    expect(expected.status).toBe(422);
    expect(REJECTED_BY[expected.code]).toBeDefined();
  });
});

describe('loadQuoteCases', () => {
  const write = (file: string, data: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'cases-'));
    writeFileSync(join(dir, file), JSON.stringify(data));
    return dir;
  };
  const valid: QuoteCase = {
    id: 'one',
    note: 'Un cas.',
    tags: ['fake'],
    input: { cart: 'Back to the Future 1' },
    expect: { status: 200, total_cents: 1500, films: { bttf_1: 1 } },
  };

  it('reads a well-formed case', () => {
    expect(loadQuoteCases(write('one.json', valid))).toEqual([valid]);
  });

  it('refuses a case outside the vocabulary of the contract', () => {
    const dir = write('one.json', { ...valid, expect: { status: 200, total_cents: 1500, films: { bttf_4: 1 } } });
    expect(() => loadQuoteCases(dir)).toThrow(/one\.json: .*property name must be valid/);
  });

  it('refuses a case whose id is not its file name', () => {
    expect(() => loadQuoteCases(write('two.json', valid))).toThrow(/id "one" differs from the file name/);
  });
});

describe('selectCases', () => {
  const tagged = (id: string, ...tags: string[]) => ({ ...cases[0], id, tags }) as QuoteCase;
  const all = [tagged('a', 'fake', 'injection'), tagged('b', 'injection'), tagged('c', 'fake')];

  it('plays only the fake-tagged cases on fake engines, all of them on live engines', () => {
    expect(selectCases(all, 'fake').map((c) => c.id)).toEqual(['a', 'c']);
    expect(selectCases(all, 'live').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('narrows to a tag', () => {
    expect(selectCases(all, 'live', 'injection').map((c) => c.id)).toEqual(['a', 'b']);
    expect(selectCases(all, 'fake', 'injection').map((c) => c.id)).toEqual(['a']);
  });
});
