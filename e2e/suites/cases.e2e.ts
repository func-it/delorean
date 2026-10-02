import { describe, expect, it } from 'vitest';
import { postQuote } from '../src/api.ts';
import { loadQuoteCases, selectCases } from '../src/cases.ts';
import { grade, outcomeOf } from '../src/outcome.ts';
import { client, expectConforms, health } from './support.ts';

const cases = selectCases(loadQuoteCases(), health.engines);

describe(`cases/quote on ${health.engines} engines`, () => {
  it.each(cases)('$id', async ({ input, expect: expected, note }) => {
    const exchange = await postQuote(client, input.cart);
    expectConforms(exchange);
    const { mismatches } = grade(expected, outcomeOf(exchange.response.status, exchange.body));
    expect(mismatches, note).toEqual([]);
  });
});
