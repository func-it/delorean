import { STAGES, type Catalog, type Film, type Health, type Quote, type Stage, type Usage } from './contract.ts';

const MODEL_STAGES: readonly Stage[] = ['guard', 'parse', 'identify', 'judge'];
const COST_TOLERANCE_USD = 1e-6;

/**
 * What any priced quote must satisfy, whatever read the cart: the arithmetic
 * of the catalog. Each invariant is checked on the figures the quote reports,
 * so one mistake shows once instead of cascading.
 */
export function quoteViolations(quote: Quote, catalog: Catalog): string[] {
  const found: string[] = [];
  const unitPrice = (film: Film) =>
    film === 'other' ? catalog.other_film_unit_price_cents : catalog.films.find((f) => f.id === film)?.unit_price_cents;

  const seen = new Set<string>();
  for (const [i, line] of quote.lines.entries()) {
    const at = `lines[${i}] "${line.title}"`;
    if (line.unit_price_cents !== unitPrice(line.film)) {
      found.push(
        `${at}: unit price ${line.unit_price_cents} for ${line.film}, the catalog says ${unitPrice(line.film) ?? 'nothing'}`,
      );
    }
    if (line.quantity > catalog.limits.max_copies_per_title) {
      found.push(
        `${at}: ${line.quantity} copies, over limits.max_copies_per_title ${catalog.limits.max_copies_per_title}`,
      );
    }
    if (line.subtotal_cents !== line.unit_price_cents * line.quantity) {
      found.push(`${at}: subtotal ${line.subtotal_cents} ≠ ${line.unit_price_cents} × ${line.quantity}`);
    }
    const title = normalizeTitle(line.title);
    if (seen.has(title)) found.push(`${at}: a second line for this title; mentions of one title are merged`);
    seen.add(title);
  }

  const subtotal = sum(quote.lines.map((l) => l.subtotal_cents));
  if (quote.subtotal_cents !== subtotal) {
    found.push(`subtotal_cents ${quote.subtotal_cents} ≠ Σ line subtotals ${subtotal}`);
  }

  const { discount } = quote;
  const sagaLines = quote.lines.filter((l) => l.film !== 'other');
  const distinct = new Set(sagaLines.map((l) => l.film)).size;
  if (discount.distinct_volumes !== distinct) {
    found.push(`discount.distinct_volumes ${discount.distinct_volumes}, the lines hold ${distinct} distinct volumes`);
  }
  const percent = tierPercent(discount.distinct_volumes, catalog);
  if (discount.percent !== percent) {
    found.push(
      `discount.percent ${discount.percent} for ${discount.distinct_volumes} distinct volumes, the catalog says ${percent}`,
    );
  }
  const base = sum(sagaLines.map((l) => l.subtotal_cents));
  if (discount.base_cents !== base) {
    found.push(`discount.base_cents ${discount.base_cents} ≠ Σ saga line subtotals ${base}`);
  }
  const amount = Math.floor((discount.base_cents * discount.percent + 50) / 100);
  if (discount.amount_cents !== amount) {
    found.push(
      `discount.amount_cents ${discount.amount_cents} ≠ ${discount.base_cents} × ${discount.percent} % = ${amount}`,
    );
  }
  if (quote.total_cents !== quote.subtotal_cents - discount.amount_cents) {
    found.push(
      `total_cents ${quote.total_cents} ≠ subtotal ${quote.subtotal_cents} − discount ${discount.amount_cents}`,
    );
  }

  const { judge } = quote;
  if (judge.score < judge.threshold) {
    found.push(`judge.score ${judge.score} is under the threshold ${judge.threshold}, yet the cart is priced`);
  }
  if (judge.checks.length > 0 && judge.score !== Math.min(...judge.checks.map((c) => c.score))) {
    found.push(`judge.score ${judge.score} is not the worst check score`);
  }
  return found;
}

/**
 * What the usage of an answer must satisfy: the stages that ran, in pipeline
 * order up to `last`, on the implementation and engines /healthz reports.
 */
export function usageViolations(usage: Usage, health: Health, last: Stage): string[] {
  const found: string[] = [];
  if (usage.implementation !== health.implementation) {
    found.push(`usage.implementation ${usage.implementation}, /healthz says ${health.implementation}`);
  }
  if (usage.engines !== health.engines) {
    found.push(`usage.engines ${usage.engines}, /healthz says ${health.engines}`);
  }

  const ran = usage.stages.map((s) => s.stage).join(' → ');
  const expected = STAGES.slice(0, STAGES.indexOf(last) + 1).join(' → ');
  if (ran !== expected) found.push(`usage.stages ran ${ran || 'nothing'}, expected ${expected}`);

  for (const stage of usage.stages) {
    const isModel = MODEL_STAGES.includes(stage.stage);
    if (!isModel && stage.cost_usd !== 0) {
      found.push(`usage.stages ${stage.stage} costs ${stage.cost_usd} USD, yet calls no model`);
    }
    if (
      isModel &&
      health.engines === 'fake' &&
      (stage.engine !== 'fake' || stage.calls !== 1 || stage.cost_usd !== 0)
    ) {
      found.push(
        `usage.stages ${stage.stage}: fake engines make one free call (engine fake), got ${JSON.stringify(stage)}`,
      );
    }
  }
  const stagesCost = sum(usage.stages.map((s) => s.cost_usd));
  if (Math.abs(usage.cost_usd - stagesCost) > COST_TOLERANCE_USD) {
    found.push(`usage.cost_usd ${usage.cost_usd} ≠ Σ stage costs ${stagesCost}`);
  }
  return found;
}

/** The largest saga discount `distinctVolumes` reaches; 0 below the first tier. */
export function tierPercent(distinctVolumes: number, catalog: Catalog): number {
  return Math.max(
    0,
    ...catalog.saga_discounts.filter((t) => distinctVolumes >= t.distinct_volumes).map((t) => t.percent),
  );
}

/** Mentions of one title, case and spaces aside, make a single line. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
