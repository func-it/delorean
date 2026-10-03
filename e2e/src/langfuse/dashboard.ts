import { parseArgs } from 'node:util';
import { langfuseConfig, type LangfuseConfig } from '../bench/langfuse.ts';
import { basicAuth, scoreNamed } from './metrics.ts';

export const DASHBOARD = 'Quotes';

/** A widget of Langfuse 4's dashboards: a metrics query and how to draw it. */
export interface Widget {
  name: string;
  description: string;
  view: 'scores-numeric' | 'scores-categorical';
  dimensions: { field: string }[];
  metrics: { measure: string; agg: string }[];
  filters: ReturnType<typeof scoreNamed>[];
  chartType: 'VERTICAL_BAR' | 'BAR_TIME_SERIES' | 'PIVOT_TABLE';
}

/**
 * The "Quotes" dashboard: per quoter (the trace's `quoter:` tag, with its
 * `engines:` tag beside it), the mean cost and latency of a quote, its p90
 * latency, and how quotes ended, from the scores every quote leaves on its
 * trace.
 */
export const WIDGETS: Widget[] = [
  {
    name: 'Mean cost per quote (USD)',
    description: 'Score cost_usd: every stage and attempt of a quote, refusals included.',
    view: 'scores-numeric',
    dimensions: [{ field: 'tags' }],
    metrics: [{ measure: 'value', agg: 'avg' }],
    filters: [scoreNamed('cost_usd')],
    chartType: 'VERTICAL_BAR',
  },
  {
    name: 'Mean latency per quote (ms)',
    description: 'Score latency_ms: the quote as the API answered it.',
    view: 'scores-numeric',
    dimensions: [{ field: 'tags' }],
    metrics: [{ measure: 'value', agg: 'avg' }],
    filters: [scoreNamed('latency_ms')],
    chartType: 'VERTICAL_BAR',
  },
  {
    name: 'p90 latency per quote (ms)',
    description: 'Score latency_ms, 90th percentile.',
    view: 'scores-numeric',
    dimensions: [{ field: 'tags' }],
    metrics: [{ measure: 'value', agg: 'p90' }],
    filters: [scoreNamed('latency_ms')],
    chartType: 'VERTICAL_BAR',
  },
  {
    name: 'Outcomes',
    description: 'Score outcome: priced, or the problem the API answered.',
    view: 'scores-categorical',
    dimensions: [{ field: 'tags' }, { field: 'stringValue' }],
    metrics: [{ measure: 'count', agg: 'count' }],
    filters: [scoreNamed('outcome')],
    chartType: 'PIVOT_TABLE',
  },
  {
    name: 'Quotes over time',
    description: 'One outcome score per quote.',
    view: 'scores-categorical',
    dimensions: [{ field: 'tags' }],
    metrics: [{ measure: 'count', agg: 'count' }],
    filters: [scoreNamed('outcome')],
    chartType: 'BAR_TIME_SERIES',
  },
];

/**
 * Creates the dashboard through Langfuse 4's dashboards API (`unstable`: it
 * may change with a Langfuse release). One already there is left as it is,
 * unless replace says to delete it and draw it anew. Returns its id.
 */
export async function createDashboard(
  config: LangfuseConfig,
  { replace = false } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; created: boolean }> {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(new URL(`/api/public/unstable/${path}`, config.baseUrl), {
      method,
      headers: { authorization: basicAuth(config), ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Langfuse ${method} ${path}: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  };

  const { data } = await call<{
    data: { id: string; name: string; definition: { widgets: { widgetId: string }[] } }[];
  }>('GET', 'dashboards?limit=100');
  const existing = data.find((d) => d.name === DASHBOARD);
  if (existing && !replace) return { id: existing.id, created: false };
  if (existing) {
    await call('DELETE', `dashboards/${existing.id}`);
    for (const { widgetId } of existing.definition.widgets) await call('DELETE', `dashboard-widgets/${widgetId}`);
  }

  const dashboard = await call<{ id: string }>('POST', 'dashboards', {
    name: DASHBOARD,
    description: 'What a quote costs and how long it takes, per quoter; how quotes end.',
  });
  for (const [i, widget] of WIDGETS.entries()) {
    const { id: widgetId } = await call<{ id: string }>('POST', 'dashboard-widgets', widget);
    // two widgets a row, each half of the 12 columns
    await call('POST', `dashboards/${dashboard.id}/placements`, {
      type: 'widget',
      widgetId,
      x: (i % 2) * 6,
      y: Math.floor(i / 2) * 6,
      width: 6,
      height: 6,
    });
  }
  return { id: dashboard.id, created: true };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { replace: { type: 'boolean', default: false } } });
  const config = langfuseConfig(process.env);
  if (!config)
    throw new Error('Langfuse is not configured: LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY');
  const { id, created } = await createDashboard(config, { replace: values.replace });
  const projects = await fetch(new URL('/api/public/projects', config.baseUrl), {
    headers: { authorization: basicAuth(config) },
  });
  const project = ((await projects.json()) as { data?: { id: string }[] }).data?.[0]?.id ?? '<project>';
  const how = created ? 'created' : 'already there (--replace draws it anew)';
  console.log(`Dashboard "${DASHBOARD}" ${how}: ${config.baseUrl}/project/${project}/dashboards/${id}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
