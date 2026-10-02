import type { FilmCounts } from '../../src/cases.ts';
import type { Catalog, Film, Quote } from '../../src/contract.ts';
import { tierPercent } from '../../src/invariants.ts';

/** The catalog of the brief, as every backend must serve it. */
export const CATALOG: Catalog = {
  currency: 'EUR',
  films: [
    { id: 'bttf_1', title: 'Back to the Future', volume: 1, unit_price_cents: 1500 },
    { id: 'bttf_2', title: 'Back to the Future Part II', volume: 2, unit_price_cents: 1500 },
    { id: 'bttf_3', title: 'Back to the Future Part III', volume: 3, unit_price_cents: 1500 },
  ],
  other_film_unit_price_cents: 2000,
  saga_discounts: [
    { distinct_volumes: 2, percent: 10 },
    { distinct_volumes: 3, percent: 20 },
  ],
  limits: { max_body_bytes: 65_536, max_input_tokens: 2048, max_copies_per_title: 1000 },
};

export function unitPrice(film: Film): number {
  return CATALOG.films.find((f) => f.id === film)?.unit_price_cents ?? CATALOG.other_film_unit_price_cents;
}

/** The saga discount of a reading, computed from scratch. */
export function discountOf(lines: { film: Film; quantity: number }[]): Quote['discount'] {
  const saga = lines.filter((l) => l.film !== 'other');
  const distinct = new Set(saga.map((l) => l.film)).size;
  const base = saga.reduce((total, l) => total + unitPrice(l.film) * l.quantity, 0);
  const percent = tierPercent(distinct, CATALOG) as Quote['discount']['percent'];
  return {
    distinct_volumes: distinct,
    percent,
    base_cents: base,
    amount_cents: Math.floor((base * percent + 50) / 100),
  };
}

/** What a cart of these films costs. */
export function totalOf(films: FilmCounts): number {
  const lines = Object.entries(films).map(([film, quantity]) => ({ film: film as Film, quantity }));
  const subtotal = lines.reduce((total, l) => total + unitPrice(l.film) * l.quantity, 0);
  return subtotal - discountOf(lines).amount_cents;
}
