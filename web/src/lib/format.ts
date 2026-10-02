const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dollars = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  // Model calls cost fractions of a cent.
  maximumFractionDigits: 4,
});
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("fr-FR");
const milliseconds = new Intl.NumberFormat("fr-FR", { style: "unit", unit: "millisecond" });
const seconds = new Intl.NumberFormat("fr-FR", { style: "unit", unit: "second", maximumFractionDigits: 1 });

/** Amounts travel as integer cents; they become euros only for display. */
export function formatCents(cents: number): string {
  return euros.format(cents / 100);
}

export function formatUsd(amount: number): string {
  return dollars.format(amount);
}

/** A ratio in [0, 1], e.g. a confidence or a judge score. */
export function formatPercent(ratio: number): string {
  return percent.format(ratio);
}

export function formatCount(value: number): string {
  return count.format(value);
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? milliseconds.format(ms) : seconds.format(ms / 1000);
}
