import type { LangfuseConfig } from '../bench/langfuse.ts';

/** The quoters, as the `quoter:<name>` tag of their traces names them. */
export const QUOTERS = ['typescript'] as const;
export type Quoter = (typeof QUOTERS)[number];

/** A filter of Langfuse's metrics API, the same in a dashboard widget. */
export interface MetricsFilter {
  column: string;
  operator: string;
  value: string | string[];
  type: 'string' | 'arrayOptions';
}

/** Only the scores of this quote measure: one name. */
export const scoreNamed = (name: string): MetricsFilter => ({
  column: 'name',
  operator: '=',
  value: name,
  type: 'string',
});

/**
 * Only the scores of one quoter. The score views of the metrics API join the
 * trace's tags, and filter on them: a score needs no quoter of its own.
 */
export const quoterTag = (quoter: Quoter): MetricsFilter => ({
  column: 'tags',
  operator: 'any of',
  value: [`quoter:${quoter}`],
  type: 'arrayOptions',
});

/** The engines a report reads: live by default, the fake ones are tests. */
export type Engines = 'live' | 'fake' | 'all';

/** Only the scores of traces on these engines; none for all. */
export const enginesTag = (engines: Engines): MetricsFilter[] =>
  engines === 'all'
    ? []
    : [{ column: 'tags', operator: 'any of', value: [`engines:${engines}`], type: 'arrayOptions' }];

export interface MetricsQuery {
  view: 'scores-numeric' | 'scores-categorical';
  metrics: { measure: string; aggregation: string }[];
  dimensions: { field: string }[];
  filters: MetricsFilter[];
  fromTimestamp: string;
  toTimestamp: string;
}

/**
 * Asks Langfuse 4's metrics API (`/api/public/v2/metrics`). In events_only
 * mode it has no traces view: the measures of a quote are the scores on its
 * trace (docs/architecture.md, "Usage, cost and traces").
 */
export async function queryMetrics(
  config: LangfuseConfig,
  query: MetricsQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const url = new URL('/api/public/v2/metrics', config.baseUrl);
  url.searchParams.set('query', JSON.stringify(query));
  const response = await fetchImpl(url, { headers: { authorization: basicAuth(config) } });
  const body = (await response.json()) as { data?: Record<string, unknown>[]; message?: string };
  if (!response.ok || !body.data) {
    throw new Error(`Langfuse metrics: ${response.status} ${body.message ?? JSON.stringify(body)}`);
  }
  return body.data;
}

export function basicAuth({ publicKey, secretKey }: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}
