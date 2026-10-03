import { parseArgs } from 'node:util';
import { langfuseConfig, type LangfuseConfig } from '../bench/langfuse.ts';
import {
  QUOTERS,
  enginesTag,
  queryMetrics,
  quoterTag,
  scoreNamed,
  type Engines,
  type MetricsQuery,
  type Quoter,
} from './metrics.ts';

/** Mean, median and p90 of one numeric score. */
export interface Spread {
  mean: number;
  median: number;
  p90: number;
}

/** What Langfuse measured of one quoter's quotes. */
export interface QuoterReport {
  quoter: Quoter;
  quotes: number;
  cost_usd?: Spread;
  latency_ms?: Spread;
  /** Each outcome's share of the quotes, 0 to 1, the largest first. */
  outcomes: { outcome: string; share: number }[];
}

/**
 * Reads, per quoter, the scores every quote leaves on its trace: how many
 * quotes, the spread of cost_usd and latency_ms, and the share of each
 * outcome. A quote is counted by its outcome score, which every quote has.
 */
export async function langfuseReport(
  config: LangfuseConfig,
  from: Date,
  { to = new Date(), engines = 'live' }: { to?: Date; engines?: Engines } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<QuoterReport[]> {
  const window = { fromTimestamp: from.toISOString(), toTimestamp: to.toISOString() };
  const onEngines = enginesTag(engines);
  const spread = async (quoter: Quoter, name: string): Promise<Spread | undefined> => {
    const query: MetricsQuery = {
      view: 'scores-numeric',
      metrics: ['avg', 'p50', 'p90'].map((aggregation) => ({ measure: 'value', aggregation })),
      dimensions: [],
      filters: [scoreNamed(name), quoterTag(quoter), ...onEngines],
      ...window,
    };
    const [row] = await queryMetrics(config, query, fetchImpl);
    if (row?.avg_value == null) return undefined;
    return { mean: Number(row.avg_value), median: Number(row.p50_value), p90: Number(row.p90_value) };
  };
  return Promise.all(
    QUOTERS.map(async (quoter) => {
      const outcomes = await queryMetrics(
        config,
        {
          view: 'scores-categorical',
          metrics: [{ measure: 'count', aggregation: 'count' }],
          dimensions: [{ field: 'stringValue' }],
          filters: [scoreNamed('outcome'), quoterTag(quoter), ...onEngines],
          ...window,
        },
        fetchImpl,
      );
      const counts = outcomes.map((row) => ({ outcome: String(row.stringValue), count: Number(row.count_count) }));
      const quotes = counts.reduce((total, c) => total + c.count, 0);
      const [cost, latency] = await Promise.all([spread(quoter, 'cost_usd'), spread(quoter, 'latency_ms')]);
      return {
        quoter,
        quotes,
        ...(cost && { cost_usd: cost }),
        ...(latency && { latency_ms: latency }),
        outcomes: counts
          .map(({ outcome, count }) => ({ outcome, share: count / quotes }))
          .sort((a, b) => b.share - a.share || a.outcome.localeCompare(b.outcome)),
      };
    }),
  );
}

/** One line per quoter: the numbers a reader compares. */
export function formatReport(reports: QuoterReport[], from: Date, engines: Engines = 'live'): string {
  const usd = (n: number) => `$${n.toFixed(5)}`;
  const ms = (n: number) => `${Math.round(n)} ms`;
  const spread = (s: Spread | undefined, unit: (n: number) => string) =>
    s ? `${unit(s.mean)} / ${unit(s.median)} / ${unit(s.p90)}` : '—';
  const which = engines === 'all' ? 'all engines' : `engines:${engines} only`;
  const lines = [`Quotes since ${from.toISOString()}, ${which} — mean / median / p90`, ''];
  for (const r of reports) {
    lines.push(`${r.quoter}: ${r.quotes} quotes`);
    if (r.quotes === 0) continue;
    lines.push(`  cost      ${spread(r.cost_usd, usd)}`);
    lines.push(`  latency   ${spread(r.latency_ms, ms)}`);
    lines.push(`  outcomes  ${r.outcomes.map((o) => `${o.outcome} ${Math.round(o.share * 100)} %`).join(', ')}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { from: { type: 'string' }, engines: { type: 'string', default: 'live' } } });
  const engines = values.engines as Engines;
  if (!['live', 'fake', 'all'].includes(engines)) throw new Error(`--engines ${engines}: live, fake or all`);
  const config = langfuseConfig(process.env);
  if (!config)
    throw new Error('Langfuse is not configured: LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY');
  const from = new Date(values.from ?? '1970-01-01T00:00:00Z');
  if (Number.isNaN(from.getTime())) throw new Error(`--from ${values.from}: not a date`);
  console.log(formatReport(await langfuseReport(config, from, { engines }), from, engines));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
