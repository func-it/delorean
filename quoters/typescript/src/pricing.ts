import { inSaga, volumeOf, type Film, type Line } from './cart.ts';

/**
 * Prices identified lines in integer cents: what each film costs, and the
 * Back to the Future discount. It never sees the customer's text, and no
 * model ever computes a price.
 */

/** What the shop sells and how it prices it. */
export interface Catalog {
  /** The saga volumes, in order. */
  volumes: readonly Volume[];
  /** The price of any film outside the saga. */
  otherUnitCents: number;
  /** The saga discounts; the highest one reached applies. */
  tiers: readonly Tier[];
}

/** A Back to the Future film as the shop sells it. */
interface Volume {
  film: Film;
  title: string;
  unitCents: number;
}

/** Takes `percent` off every saga DVD once a cart holds `distinctVolumes` different volumes. */
interface Tier {
  distinctVolumes: number;
  percent: number;
}

/** The shop's catalog: 15 EUR a volume, 20 EUR any other film, 10 % off the saga with two distinct volumes, 20 % with three. */
export const DEFAULT_CATALOG: Catalog = {
  volumes: [
    { film: 'bttf_1', title: 'Back to the Future', unitCents: 1500 },
    { film: 'bttf_2', title: 'Back to the Future Part II', unitCents: 1500 },
    { film: 'bttf_3', title: 'Back to the Future Part III', unitCents: 1500 },
  ],
  otherUnitCents: 2000,
  tiers: [
    { distinctVolumes: 2, percent: 10 },
    { distinctVolumes: 3, percent: 20 },
  ],
};

/** A line with its price. */
interface PricedLine extends Line {
  unitCents: number;
  subtotalCents: number;
}

/** The saga discount of a cart; `percent` is 0 when no tier is reached. */
interface Discount {
  distinctVolumes: number;
  percent: number;
  /** The subtotal of the saga lines, on which `percent` applies. */
  baseCents: number;
  amountCents: number;
}

/** A priced cart. */
export interface Price {
  lines: PricedLine[];
  subtotalCents: number;
  discount: Discount;
  totalCents: number;
}

/** The price of one copy of a film. */
export function unitCents(catalog: Catalog, film: Film): number {
  return catalog.volumes.find((v) => v.film === film)?.unitCents ?? catalog.otherUnitCents;
}

/**
 * Prices lines: each at its unit price, then the highest tier the distinct
 * saga volumes reach, taken off the saga lines only. Two lines of one volume
 * count once among the distinct volumes, and both in the base.
 */
export function price(catalog: Catalog, lines: readonly Line[]): Price {
  const priced = lines.map((line) => {
    const unit = unitCents(catalog, line.film);
    return { ...line, unitCents: unit, subtotalCents: unit * line.quantity };
  });
  const saga = priced.filter((l) => inSaga(l.film));
  const distinctVolumes = new Set(saga.map((l) => volumeOf(l.film))).size;
  const reached = catalog.tiers
    .filter((t) => distinctVolumes >= t.distinctVolumes)
    .reduce((best, t) => (t.distinctVolumes > best.distinctVolumes ? t : best), { distinctVolumes: 0, percent: 0 });
  const baseCents = sum(saga.map((l) => l.subtotalCents));
  // to the cent, half up; on this catalog the division is always exact
  const amountCents = Math.floor((baseCents * reached.percent + 50) / 100);
  const subtotalCents = sum(priced.map((l) => l.subtotalCents));
  return {
    lines: priced,
    subtotalCents,
    discount: { distinctVolumes, percent: reached.percent, baseCents, amountCents },
    totalCents: subtotalCents - amountCents,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
