import { describe, expect, it } from 'vitest';
import { MAX_QUANTITY, type Film, type Line } from '../src/cart.ts';
import { DEFAULT_CATALOG, price, unitCents, type Catalog } from '../src/pricing.ts';

const line = (title: string, quantity: number, film: Film): Line => ({ title, quantity, film, confidence: 1 });
const bttf1 = line('Back to the Future 1', 1, 'bttf_1');
const bttf2 = line('Back to the Future 2', 1, 'bttf_2');
const bttf3 = line('Back to the Future 3', 1, 'bttf_3');
const chevre = line('La chèvre', 1, 'other');

describe('price', () => {
  it.each([
    ['brief 1: the three volumes, 20 %', [bttf1, bttf2, bttf3], 4500, [3, 20, 4500, 900], 3600],
    ['brief 2: two volumes, 10 %', [bttf1, bttf3], 3000, [2, 10, 3000, 300], 2700],
    ['brief 3: one volume, no discount', [bttf1], 1500, [1, 0, 1500, 0], 1500],
    [
      'brief 4: a second copy is in the base, not among the distinct volumes',
      [bttf1, bttf2, bttf3, bttf2],
      6000,
      [3, 20, 6000, 1200],
      4800,
    ],
    [
      'brief 5: another film is full price, out of the base',
      [bttf1, bttf2, bttf3, chevre],
      6500,
      [3, 20, 4500, 900],
      5600,
    ],
    [
      'two titles of one volume count once',
      [line('BTTF 2', 1, 'bttf_2'), line('Retour vers le futur 2', 1, 'bttf_2')],
      3000,
      [1, 0, 3000, 0],
      3000,
    ],
    [
      'two titles of one volume and another volume reach 10 %',
      [line('BTTF 2', 1, 'bttf_2'), line('Retour vers le futur 2', 1, 'bttf_2'), bttf1],
      4500,
      [2, 10, 4500, 450],
      4050,
    ],
    ['other films only', [chevre, line('Le Grand Bleu', 3, 'other')], 8000, [0, 0, 0, 0], 8000],
    [
      'many copies',
      [line('Back to the Future', 100, 'bttf_1'), bttf2, line('Heat', 2, 'other')],
      155500,
      [2, 10, 151500, 15150],
      140350,
    ],
    [
      'the most a cart may hold of each volume',
      [line('1', MAX_QUANTITY, 'bttf_1'), line('2', MAX_QUANTITY, 'bttf_2'), line('3', MAX_QUANTITY, 'bttf_3')],
      4_500_000,
      [3, 20, 4_500_000, 900_000],
      3_600_000,
    ],
    ['no lines', [], 0, [0, 0, 0, 0], 0],
  ] as const)('%s', (_, lines, subtotal, [distinctVolumes, percent, baseCents, amountCents], total) => {
    const quote = price(DEFAULT_CATALOG, lines);
    expect(quote.subtotalCents).toBe(subtotal);
    expect(quote.discount).toEqual({ distinctVolumes, percent, baseCents, amountCents });
    expect(quote.totalCents).toBe(total);
    expect(quote.lines.map(({ title, quantity, film, confidence }) => ({ title, quantity, film, confidence }))).toEqual(
      lines,
    );
    for (const l of quote.lines) expect(l.subtotalCents).toBe(l.unitCents * l.quantity);
    expect(quote.lines.reduce((sum, l) => sum + l.subtotalCents, 0)).toBe(quote.subtotalCents);
  });

  it('prices a volume 15 € and any other film 20 €', () => {
    expect((['bttf_1', 'bttf_2', 'bttf_3', 'other'] as const).map((f) => unitCents(DEFAULT_CATALOG, f))).toEqual([
      1500, 1500, 1500, 2000,
    ]);
  });

  // The default catalog always divides exactly; odd prices show the rounding, half up.
  it.each([
    ['half rounds up', [line('1', 1, 'bttf_1'), line('3', 1, 'bttf_3')], 301], // 10 % of 3005
    ['below half rounds down', [line('2', 1, 'bttf_2'), line('3', 1, 'bttf_3')], 300], // 10 % of 3004
  ])('rounds the discount to the cent, %s', (_, lines, amount) => {
    const [first, second, third] = DEFAULT_CATALOG.volumes;
    const odd: Catalog = {
      ...DEFAULT_CATALOG,
      volumes: [{ ...first!, unitCents: 1505 }, { ...second!, unitCents: 1504 }, third!],
    };
    expect(price(odd, lines).discount.amountCents).toBe(amount);
  });
});
