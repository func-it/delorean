import { describe, expect, it } from 'vitest';
import { filmsOf, grade } from '../src/outcome.ts';

describe('filmsOf', () => {
  it('sums the quantities per film, every other film under other', () => {
    expect(
      filmsOf([
        { film: 'bttf_2', quantity: 1 },
        { film: 'other', quantity: 2 },
        { film: 'bttf_2', quantity: 1 },
        { film: 'other', quantity: 1 },
      ]),
    ).toEqual({ bttf_2: 2, other: 3 });
  });
});

describe('grade', () => {
  const priced = { status: 200 as const, total_cents: 3600, films: { bttf_1: 1, bttf_2: 1, bttf_3: 1 } };

  it('passes a cart priced at the expected total with the expected films', () => {
    expect(grade(priced, { status: 200, total_cents: 3600, films: { bttf_3: 1, bttf_2: 1, bttf_1: 1 } })).toEqual({
      passed: true,
      price: true,
      films: true,
      mismatches: [],
    });
  });

  it('tells the price from the reading', () => {
    const right = grade(priced, { status: 200, total_cents: 3600, films: { bttf_1: 3 } });
    expect(right).toMatchObject({ passed: false, price: true, films: false });
    expect(right.mismatches).toEqual(['films: expected {bttf_1: 1, bttf_2: 1, bttf_3: 1}, got {bttf_1: 3}']);
  });

  it('fails every check of a priced case when the cart is refused', () => {
    expect(grade(priced, { status: 422, code: 'injection' })).toEqual({
      passed: false,
      price: false,
      films: false,
      mismatches: ['expected 200, got 422 injection'],
    });
  });

  it('passes a refusal only with the expected code', () => {
    const expected = { status: 422, code: 'injection' as const };
    expect(grade(expected, { status: 422, code: 'injection' })).toEqual({
      passed: true,
      rejection: true,
      mismatches: [],
    });
    expect(grade(expected, { status: 422, code: 'invalid_request' })).toEqual({
      passed: false,
      rejection: false,
      mismatches: ['expected 422 injection, got 422 invalid_request'],
    });
  });

  it('does not grade films a case does not list', () => {
    expect(grade({ status: 200, total_cents: 1500 }, { status: 200, total_cents: 1500, films: {} })).toEqual({
      passed: true,
      price: true,
      mismatches: [],
    });
  });
});
