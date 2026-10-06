import { describe, expect, it } from 'vitest';
import { newPipeline, quote, rejection } from './support.ts';

/**
 * The five examples of the brief, as a customer would type them, through the whole reading (the fake
 * engines stand in for the models; the price is the code's, as always). The README starts from these.
 *
 * A Back to the Future volume costs 15 €, any other film 20 €; two different volumes in the cart take
 * 10 % off every Back to the Future DVD, three take 20 %.
 */
const euros = (cents: number) => cents / 100;

describe('the brief', () => {
  it.each([
    ['1. the three volumes: 20 % off', 'Back to the Future 1\nBack to the Future 2\nBack to the Future 3', 36],
    ['2. two volumes: 10 % off', 'Back to the Future 1\nBack to the Future 3', 27],
    ['3. one volume: no discount', 'Back to the Future 1', 15],
    [
      '4. the second copy of a volume is priced, not counted as a third volume: (15 × 4) − 20 %',
      'Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nBack to the Future 2',
      48,
    ],
    [
      '5. another film costs 20 €, outside the discount: (15 × 3 − 20 %) + 20',
      'Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre',
      56,
    ],
  ])('%s', async (_, cart, expected) => {
    const priced = await quote(newPipeline(), cart);

    expect(euros(priced.price.totalCents)).toBe(expected);
  });

  it('reads the simple forms of the brief: Arabic or Roman numerals, with or without "Part", any case, free spacing', async () => {
    const forms = [
      ['back to the future I', 'BACK TO THE FUTURE   II', 'Back to the Future\tPart III'],
      ['  Back to the Future Part 1', 'back  to the future 2', 'BACK TO THE FUTURE PART 3  '],
    ];
    for (const lines of forms) {
      const priced = await quote(newPipeline(), lines.join('\n'));

      expect(euros(priced.price.totalCents)).toBe(36);
    }
  });

  // the demo mode reads one title per line, a quantity in front if wanted; another film is 20 €
  it.each([
    ['a quantity in front, no x: 2 × 15 (one volume, no discount) + 20', '2 Back to the Future 2\nMatrix', 50],
    ['a quantity in front, with x: the same', '2 x Back to the Future 2\nMatrix', 50],
    ['another film alone', 'La chèvre', 20],
    ['two copies of another film', '2 La chèvre', 40],
  ])('%s', async (_, cart, expected) => {
    const priced = await quote(newPipeline(), cart);

    expect(euros(priced.price.totalCents)).toBe(expected);
  });

  it.each([
    'Back to the Future 1, Back to the Future 2, Back to the Future 3',
    'Back to the Future 1 and Back to the Future 3',
    'I would like Back to the Future 1 please',
  ])('refuses %j, which the demo mode cannot read safely, instead of pricing it as another film', async (line) => {
    const refused = await rejection(quote(newPipeline(), `Matrix\n${line}`));

    expect(refused.code).toBe('demo_unreadable');
    expect(refused.detail).toContain(JSON.stringify(line));
  });
});
