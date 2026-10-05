import type { QuoteCase } from '../cases.ts';
import { STAGES, type Health, type Stage } from '../contract.ts';
import type { Attempt } from './run.ts';

/** `hits` out of `total`; `rate` is null when nothing was counted. */
export interface Rate {
  hits: number;
  total: number;
  rate: number | null;
}

export interface Spread {
  p50: number | null;
  p90: number | null;
  max: number | null;
}

interface StageSummary {
  stage: Stage;
  /** How many answers ran this stage. */
  runs: number;
  duration_ms: Spread;
  cost_usd: { mean: number; total: number };
}

export interface Summary {
  /** Attempts that met every expectation of their case. */
  accuracy: Rate;
  /** Carts to price, priced at the expected total. */
  price: Rate;
  /** Carts to price, read with the expected quantity per film. */
  films: Rate;
  /** Carts to refuse, refused with the expected status and code. */
  rejection: Rate;
  /** No answer, a 5xx, or an answer outside the contract. */
  errors: Rate;
  latency_ms: Spread;
  cost_usd: { per_cart: number | null; total: number };
  stages: StageSummary[];
}

export interface CaseSummary {
  id: string;
  tags: string[];
  passed: number;
  runs: number;
  /** Every distinct way the case failed, over all passes. */
  mismatches: string[];
}

export interface Report {
  engines: Health['engines'];
  version: string;
  base_url: string;
  tag: string | null;
  runs: number;
  concurrency: number;
  started_at: string;
  finished_at: string;
  requests: number;
  summary: Summary;
  cases: CaseSummary[];
  attempts: Attempt[];
}

export function summarize(attempts: Attempt[]): Summary {
  const usages = attempts.flatMap((a) => (a.usage ? [a.usage] : []));
  const totalCost = sum(usages.map((u) => u.cost_usd));
  return {
    accuracy: rate(attempts.map((a) => a.grade.passed)),
    price: rate(attempts.flatMap((a) => a.grade.price ?? [])),
    films: rate(attempts.flatMap((a) => a.grade.films ?? [])),
    rejection: rate(attempts.flatMap((a) => a.grade.rejection ?? [])),
    errors: rate(attempts.map((a) => a.error !== undefined)),
    latency_ms: spread(attempts.map((a) => a.latency_ms)),
    cost_usd: { per_cart: usages.length > 0 ? totalCost / usages.length : null, total: totalCost },
    stages: STAGES.flatMap((stage) => {
      const runs = usages.flatMap((u) => u.stages.filter((s) => s.stage === stage));
      if (runs.length === 0) return [];
      const cost = sum(runs.map((s) => s.cost_usd));
      return [
        {
          stage,
          runs: runs.length,
          duration_ms: spread(runs.map((s) => s.duration_ms)),
          cost_usd: { mean: cost / runs.length, total: cost },
        },
      ];
    }),
  };
}

export function summarizeCases(cases: QuoteCase[], attempts: Attempt[]): CaseSummary[] {
  return cases.map(({ id, tags }) => {
    const own = attempts.filter((a) => a.case_id === id);
    return {
      id,
      tags,
      passed: own.filter((a) => a.grade.passed).length,
      runs: own.length,
      mismatches: [...new Set(own.flatMap((a) => a.grade.mismatches))],
    };
  });
}

export function rate(flags: boolean[]): Rate {
  const hits = flags.filter(Boolean).length;
  return { hits, total: flags.length, rate: flags.length > 0 ? hits / flags.length : null };
}

function spread(values: number[]): Spread {
  return { p50: percentile(values, 50), p90: percentile(values, 90), max: percentile(values, 100) };
}

/** Nearest-rank percentile: the smallest value with at least p % of the values at or below it. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

/** `fake-20261002T132501Z`: the engines, and when the bench started. */
export function reportName(report: Pick<Report, 'engines' | 'started_at'>): string {
  const stamp = report.started_at.replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${report.engines}-${stamp}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
