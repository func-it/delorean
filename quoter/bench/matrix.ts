import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Estimate } from './dryrun.ts';
import type { Report } from './run.ts';
import type { Summary } from './stats.ts';

/**
 * A matrix benches a subject once per variant of a variants file, and compares them in one table. A variant is one
 * way to configure the service: a name, and environment overrides on top of the service's own configuration. One
 * code, configured: no fork.
 */
export interface Variant {
  name: string;
  note?: string;
  env: Record<string, string>;
}

/** What a variant's name may be: it names a report file and a Langfuse experiment. */
const VARIANT_NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** Reads a variants file: `{variants: [{name, note?, env}]}`, each name unique. */
export function loadVariants(path: string): Variant[] {
  const doc: unknown = parse(readFileSync(path, 'utf8'));
  const problem = (why: string) => new Error(`${path}: ${why}`);
  if (!isObject(doc) || Object.keys(doc).some((k) => k !== 'variants')) {
    throw problem('a file of {variants: [{name, note?, env}]}');
  }
  const list = doc.variants;
  if (!Array.isArray(list) || list.length === 0) throw problem('no variant');
  const problems: string[] = [];
  const seen = new Set<string>();
  const variants = list.map((item: unknown, i): Variant => {
    const v = isObject(item) ? item : {};
    const unknown = Object.keys(v).filter((k) => !['name', 'note', 'env'].includes(k));
    const name = typeof v.name === 'string' ? v.name : '';
    if (unknown.length > 0) problems.push(`variant ${i + 1}: unknown field ${unknown.join(', ')}`);
    if (!VARIANT_NAME.test(name)) {
      problems.push(
        `variant ${i + 1}: name ${JSON.stringify(v.name)}, want lowercase letters, digits, dots and dashes`,
      );
    } else if (seen.has(name)) problems.push(`variant ${JSON.stringify(name)} twice`);
    seen.add(name);
    const env = isObject(v.env) ? v.env : {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') problems.push(`variant ${JSON.stringify(name)}: ${key} must be a string`);
    }
    return { name, ...(typeof v.note === 'string' && { note: v.note }), env: env as Record<string, string> };
  });
  if (problems.length > 0) throw problem(problems.join('\n'));
  return variants;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One variant in the comparison of a matrix: what it is, how often it read right, how long the parse took, and what a cart cost. */
export interface Row {
  variant: string;
  model: string;
  effort: string;
  strategy: string;
  /** The model answers on this machine: no bill. */
  local: boolean;
  /** The runs of the subject's first metric (films), over every case: passed of scored. */
  passed: number;
  scored: number;
  cases_failed: number;
  /** The parse stage's latency, in ms. */
  p50_ms: number;
  p90_ms: number;
  /** The mean cost of a cart's plays (parse and identify), in USD. */
  cost_per_cart_usd: number;
  errors: number;
  /** The row is a dry run's: a cost estimated from the token counts and the models' prices, nothing measured. */
  estimated?: boolean;
  /** The spend reached the cap: some plays, or the whole variant, were not run. */
  cut_short?: boolean;
  /** The model calls a cart takes, when estimated. */
  llm_calls_per_cart?: number;
  jev_calls_per_cart?: number;
}

/** The row of a variant that is not run yet: what it is, nothing measured. */
export function describedRow(fields: Pick<Row, 'variant' | 'model' | 'effort' | 'strategy' | 'local'>): Row {
  return { ...fields, passed: 0, scored: 0, cases_failed: 0, p50_ms: 0, p90_ms: 0, cost_per_cart_usd: 0, errors: 0 };
}

/** A run's report and stats read into the row of a variant, whose model, effort, strategy and locality `row` carries already. */
export function rowOf(row: Row, report: Report, summary: Summary): Row {
  const metric = report.metrics[0] ?? '';
  const out: Row = { ...row };
  for (const id of report.cases) {
    let failed = false;
    for (const scored of report.scores[id] ?? []) {
      if (scored.skipped) continue; // not played: the spend reached the cap
      const score = scored.scores?.[metric];
      if (score === undefined) {
        failed = true;
        continue;
      }
      out.scored++;
      if (score >= (report.thresholds[metric] ?? 0)) out.passed++;
      else failed = true;
    }
    if (failed) out.cases_failed++;
  }
  const parse = summary.stages.parse;
  out.p50_ms = parse?.p50 ?? 0;
  out.p90_ms = parse?.p90 ?? 0;
  const carts = summary.plays + summary.failed;
  if (carts > 0) out.cost_per_cart_usd = summary.cost / carts;
  out.errors = summary.failed;
  if (report.cutShort) out.cut_short = true;
  return out;
}

/** What one Jev decision costs, as measured on the benches (docs/testing.md, Cost): the models API does not price Jev, which is not on chat completions. */
export const JEV_CALL_USD = 0.00003;

/** What a model costs on OpenRouter, in USD a token, and whether it can answer under a strict JSON schema. */
export interface Price {
  prompt: number;
  completion: number;
  structuredOutputs: boolean;
}

/** OpenRouter's list of models and their prices: a GET without key, at no cost. MODELS_API overrides it, for the tests. */
export const MODELS_API = 'https://openrouter.ai/api/v1/models';

/** Reads OpenRouter's models API: each model's price and whether it supports structured outputs. */
export async function fetchPrices(
  url: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Map<string, Price>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`models API: status ${response.status}`);
  const body = (await response.json()) as {
    data?: {
      id: string;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }[];
  };
  return new Map(
    (body.data ?? []).map((m) => [
      m.id,
      {
        prompt: Number(m.pricing?.prompt ?? 0) || 0,
        completion: Number(m.pricing?.completion ?? 0) || 0,
        structuredOutputs: m.supported_parameters?.includes('structured_outputs') ?? false,
      },
    ]),
  );
}

/**
 * A dry run's row for a variant: the cost of a cart from its estimate (the readings' tokens at the model's
 * price, nothing for a local model, and Jev's calls at JEV_CALL_USD) over `cases` carts.
 */
export function estimatedRow(row: Row, estimate: Estimate, cases: number, price: Price): Row {
  const out: Row = { ...row, estimated: true };
  if (cases === 0) return out;
  const llm = row.local ? 0 : estimate.llmTokens * price.prompt + estimate.outputTokens * price.completion;
  out.cost_per_cart_usd = (llm + estimate.jev * JEV_CALL_USD) / cases;
  out.llm_calls_per_cart = estimate.llm / cases;
  out.jev_calls_per_cart = estimate.jev / cases;
  return out;
}

/** The comparison of a matrix in Markdown, a row a variant. */
export function table(rows: readonly Row[]): string {
  const dry = rows[0]?.estimated === true;
  const lines = dry
    ? [
        '| variant | model | effort | strategy | LLM calls / cart | Jev calls / cart | ≈ cost / cart | ≈ cost / 1,000 carts |',
        '|---|---|---|---|---:|---:|---:|---:|',
      ]
    : [
        '| variant | model | effort | strategy | accuracy | cases failed | p50 | p90 | cost / cart | cost / 1,000 carts | errors |',
        '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
      ];
  for (const r of rows) {
    const model = r.local ? `${r.model} (local)` : r.model;
    if (dry) {
      lines.push(
        `| ${r.variant} | ${model} | ${r.effort} | ${r.strategy} | ${(r.llm_calls_per_cart ?? 0).toFixed(1)} | ` +
          `${(r.jev_calls_per_cart ?? 0).toFixed(1)} | $${r.cost_per_cart_usd.toFixed(6)} | $${(r.cost_per_cart_usd * 1000).toFixed(3)} |`,
      );
      continue;
    }
    let accuracy = r.scored > 0 ? `${r.passed} / ${r.scored} (${Math.round((100 * r.passed) / r.scored)} %)` : '—';
    if (r.cut_short) accuracy += ' — cut short';
    lines.push(
      `| ${r.variant} | ${model} | ${r.effort} | ${r.strategy} | ${accuracy} | ${r.cases_failed} | ${r.p50_ms} ms | ` +
        `${r.p90_ms} ms | $${r.cost_per_cart_usd.toFixed(6)} | $${(r.cost_per_cart_usd * 1000).toFixed(3)} | ${r.errors} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
