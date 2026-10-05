import type { Catalog } from "@/lib/contract";
import { formatCents } from "@/lib/format";

/**
 * What the shop charges, in a sentence for the footer, written from the quoter's own catalog: the prices
 * and the discounts are never copied into the page. Undefined when the catalog says too little to write it.
 */
export function describePrices(catalog: Catalog | undefined): string | undefined {
  if (!catalog || catalog.films.length === 0) return undefined;
  const prices = [...new Set(catalog.films.map((film) => film.unit_price_cents))];
  const saga =
    prices.length === 1 && prices[0] !== undefined
      ? `Chaque volet de la saga : ${formatCents(prices[0])} le DVD`
      : `Les volets de la saga : ${catalog.films
          .toSorted((a, b) => a.volume - b.volume)
          .map((film) => `${film.volume} : ${formatCents(film.unit_price_cents)}`)
          .join(", ")}`;
  const sentences = [`${saga}, tout autre film : ${formatCents(catalog.other_film_unit_price_cents)}.`];
  const tiers = catalog.saga_discounts.toSorted((a, b) => a.distinct_volumes - b.distinct_volumes);
  if (tiers.length > 0) {
    const steps = tiers.map((tier) => `${tier.distinct_volumes} volets différents : −${tier.percent} %`).join(", ");
    sentences.push(`Remise sur les DVD de la saga, selon les volets différents du panier : ${steps}.`);
  }
  return sentences.join(" ");
}
