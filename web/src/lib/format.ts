const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("fr-FR");

/** Amounts travel as integer cents; they become euros only for display. */
export function formatCents(cents: number): string {
  return euros.format(cents / 100);
}

/** A ratio in [0, 1], e.g. a confidence or a judge score. */
export function formatPercent(ratio: number): string {
  return percent.format(ratio);
}

export function formatCount(value: number): string {
  return count.format(value);
}
