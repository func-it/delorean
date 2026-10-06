import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { casesDir, countCases, folders, loadCases, readCase, validate } from '../bench/cases.ts';
import { aCase, files } from './bench-support.ts';

/** A folder of one good case for each stage, which a test spoils. */
function good(extra: Record<string, unknown> = {}) {
  return files({
    'guard/a.json': aCase('a', { text: 'Back to the Future 1' }, { verdict: 'valid' }),
    'identify/b.json': aCase('b', { title: 'Retour vers le futur 2' }, { film: 'bttf_2' }),
    'reading/c.json': aCase('c', { text: 'Back to the Future 1 x2' }, { films: { bttf_1: 2 } }),
    'judge/d.json': aCase(
      'd',
      { text: 'Back to the Future 1', lines: [{ title: 'Back to the Future 1', quantity: 1, film: 'bttf_1' }] },
      { faithful: true },
    ),
    ...extra,
  });
}

describe('the repository cases', () => {
  const base = casesDir();

  it('are all well formed', () => {
    expect(validate(base)).toEqual([]);
  });

  it('are the 262 stage cases that were played alone', () => {
    const counts = Object.fromEntries(folders().map((f) => [f, loadCases(join(base, f)).length]));
    expect(counts).toEqual({ guard: 113, identify: 61, judge: 42, reading: 46 });
    expect(countCases(join(base, 'quote'))).toBeGreaterThan(80);
  });

  it('are read in the order of their ids', () => {
    const ids = loadCases(join(base, 'guard')).map((c) => c.id);
    expect(ids).toEqual(ids.toSorted());
  });
});

describe('validate', () => {
  it('has nothing to say of well formed cases, and skips quote, which the end-to-end suite checks', () => {
    const base = good({ 'quote/e.json': { anything: true } });
    expect(validate(base)).toEqual([]);
  });

  it('refuses a folder no subject reads, and a folder that is missing', () => {
    const base = good({ 'other/x.json': aCase('x', {}, {}) });
    expect(validate(base).join('\n')).toContain('no subject reads this folder');
    expect(validate(files({ 'guard/a.json': aCase('a', { text: 't' }, { verdict: 'valid' }) })).join('\n')).toMatch(
      /identify: missing/,
    );
  });

  it.each([
    [
      'an id that is not its file name',
      { 'guard/a.json': aCase('z', { text: 't' }, { verdict: 'valid' }) },
      'must be named z.json',
    ],
    [
      'a field no case has',
      { 'guard/a.json': aCase('a', { text: 't' }, { verdict: 'valid' }, { extra: 1 }) },
      'unknown field "extra"',
    ],
    [
      'a case with no note',
      { 'guard/a.json': aCase('a', { text: 't' }, { verdict: 'valid' }, { note: ' ' }) },
      'no note',
    ],
    [
      'a tag repeated',
      { 'guard/a.json': aCase('a', { text: 't' }, { verdict: 'valid' }, { tags: ['x', 'x'] }) },
      'tag "x" empty or repeated',
    ],
    ['text that is not JSON', { 'guard/a.json': '{not json' }, 'a.json'],
    [
      'an empty guard text',
      { 'guard/a.json': aCase('a', { text: '  ' }, { verdict: 'valid' }) },
      'the guard never sees an empty cart',
    ],
    [
      'an unknown verdict',
      { 'guard/a.json': aCase('a', { text: 't' }, { verdict: 'maybe' }) },
      'verdict "maybe" unknown',
    ],
    [
      'a guard input with another field',
      { 'guard/a.json': aCase('a', { text: 't', more: 1 }, { verdict: 'valid' }) },
      'input: unknown field "more"',
    ],
    ['a missing expect', { 'guard/a.json': { id: 'a', note: 'n', input: { text: 't' } } }, 'expect missing'],
    [
      'an unknown film to identify',
      { 'identify/b.json': aCase('b', { title: 't' }, { film: 'bttf_4' }) },
      'film "bttf_4" unknown',
    ],
    ['an empty title', { 'identify/b.json': aCase('b', { title: '' }, { film: 'other' }) }, 'input.title empty'],
    ['a reading with no films', { 'reading/c.json': aCase('c', { text: 't' }, {}) }, 'expect.films missing'],
    [
      'a quantity of 0',
      { 'reading/c.json': aCase('c', { text: 't' }, { films: { bttf_1: 0 } }) },
      'quantity 0, at least 1',
    ],
    [
      'an unknown film in a reading',
      { 'reading/c.json': aCase('c', { text: 't' }, { films: { jaws: 1 } }) },
      'film "jaws" unknown',
    ],
    [
      'a judge with no lines',
      { 'judge/d.json': aCase('d', { text: 't', lines: [] }, { faithful: true }) },
      'input.lines empty',
    ],
    [
      'a line without a known film',
      {
        'judge/d.json': aCase(
          'd',
          { text: 't', lines: [{ title: 'x', quantity: 1, film: 'jaws' }] },
          { faithful: true },
        ),
      },
      'line 1:',
    ],
    [
      'a faithful reading with a failing check',
      {
        'judge/d.json': aCase(
          'd',
          { text: 't', lines: [{ title: 'x', quantity: 1, film: 'other' }] },
          { faithful: true, check: 'asked' },
        ),
      },
      'a faithful reading expects no failing check',
    ],
    [
      'a check no one knows',
      {
        'judge/d.json': aCase(
          'd',
          { text: 't', lines: [{ title: 'x', quantity: 1, film: 'other' }] },
          { faithful: false, check: 'vibes' },
        ),
      },
      'check "vibes" unknown',
    ],
    [
      'a judge without its verdict',
      { 'judge/d.json': aCase('d', { text: 't', lines: [{ title: 'x', quantity: 1, film: 'other' }] }, {}) },
      'expect.faithful missing',
    ],
  ])('says what is wrong with %s', (_what, spoiled, message) => {
    const problems = validate(good(spoiled));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(message);
  });

  it('says a folder holds no case', () => {
    expect(validate(files({ 'guard/.keep': '' })).join('\n')).toContain('guard: no case');
  });
});

describe('readCase', () => {
  it('reads the fields of a case, and no tags is none', () => {
    const base = files({ 'a.json': { id: 'a', note: 'n', input: { text: 't' }, expect: { verdict: 'valid' } } });
    expect(readCase(join(base, 'a.json'))).toEqual({
      id: 'a',
      note: 'n',
      input: { text: 't' },
      expect: { verdict: 'valid' },
    });
  });

  it('refuses what is not a case object', () => {
    const base = files({ 'a.json': '[1]' });
    expect(() => readCase(join(base, 'a.json'))).toThrow('a case is a JSON object');
  });
});
