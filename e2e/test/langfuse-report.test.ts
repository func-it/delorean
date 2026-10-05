import { describe, expect, it } from 'vitest';
import { createDashboard, DASHBOARD, WIDGETS } from '../src/langfuse/dashboard.ts';
import type { MetricsQuery } from '../src/langfuse/metrics.ts';
import { formatReport, langfuseReport } from '../src/langfuse/report.ts';

const config = { baseUrl: 'http://langfuse.test', publicKey: 'pk', secretKey: 'sk' };

/** A fetch that answers from `answer` and keeps every request. */
function stubFetch(answer: (method: string, url: URL) => unknown) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchImpl = ((input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    return Promise.resolve(new Response(JSON.stringify(answer(method, url)), { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The metrics query a request carries. */
function queryOf(url: URL | undefined): MetricsQuery {
  return JSON.parse(url?.searchParams.get('query') ?? '{}') as MetricsQuery;
}

describe('langfuseReport', () => {
  it('reads each quoter from the scores of its traces, filtered by its quoter tag', async () => {
    const { fetchImpl, calls } = stubFetch((_, url) => {
      const query = queryOf(url);
      const quoter = query.filters.find((f) => f.column === 'tags')?.value[0];
      const name = query.filters.find((f) => f.column === 'name')?.value;
      if (quoter !== 'quoter:typescript') return { data: query.view === 'scores-numeric' ? [{}] : [] };
      if (name === 'outcome') {
        return {
          data: [
            { stringValue: 'priced', count_count: 3 },
            { stringValue: 'injection', count_count: 1 },
          ],
        };
      }
      return {
        data: [
          name === 'cost_usd'
            ? { avg_value: 0.0005, p50_value: 0.0004, p90_value: 0.0009 }
            : { avg_value: 3810, p50_value: 3500, p90_value: 5200 },
        ],
      };
    });
    const from = new Date('2026-10-01T00:00:00Z');
    const reports = await langfuseReport(config, from, { to: new Date('2026-10-02T00:00:00Z') }, fetchImpl);

    expect(reports).toEqual([
      {
        quoter: 'typescript',
        quotes: 4,
        cost_usd: { mean: 0.0005, median: 0.0004, p90: 0.0009 },
        latency_ms: { mean: 3810, median: 3500, p90: 5200 },
        outcomes: [
          { outcome: 'priced', share: 0.75 },
          { outcome: 'injection', share: 0.25 },
        ],
      },
    ]);
    expect(calls[0]?.url.pathname).toBe('/api/public/v2/metrics');
    expect(queryOf(calls[0]?.url)).toMatchObject({
      fromTimestamp: '2026-10-01T00:00:00.000Z',
      toTimestamp: '2026-10-02T00:00:00.000Z',
    });
    // live engines by default: the fake ones are tests
    expect(queryOf(calls[0]?.url).filters).toContainEqual({
      column: 'tags',
      operator: 'any of',
      value: ['engines:live'],
      type: 'arrayOptions',
    });
    expect(formatReport(reports, from)).toContain('engines:live only');
    expect(formatReport(reports, from)).toContain(
      'typescript: 4 quotes\n  cost      $0.00050 / $0.00040 / $0.00090\n  latency   3810 ms / 3500 ms / 5200 ms\n  outcomes  priced 75 %, injection 25 %',
    );
  });
});

describe('createDashboard', () => {
  it('creates the dashboard, its widgets and their places, once', async () => {
    let widget = 0;
    const { fetchImpl, calls } = stubFetch((method, url) => {
      if (method === 'GET') return { data: [] };
      if (url.pathname.endsWith('/dashboards')) return { id: 'd1' };
      if (url.pathname.endsWith('/dashboard-widgets')) return { id: `w${++widget}` };
      return {};
    });
    expect(await createDashboard(config, {}, fetchImpl)).toEqual({ id: 'd1', created: true });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts[0]?.body).toMatchObject({ name: DASHBOARD });
    expect(posts.filter((c) => c.url.pathname.endsWith('/dashboard-widgets')).map((c) => c.body)).toEqual(WIDGETS);
    expect(posts.at(-1)).toMatchObject({
      url: new URL('http://langfuse.test/api/public/unstable/dashboards/d1/placements'),
      body: { type: 'widget', widgetId: `w${WIDGETS.length}`, width: 6, height: 6 },
    });

    const again = stubFetch(() => ({ data: [{ id: 'd1', name: DASHBOARD, definition: { widgets: [] } }] }));
    expect(await createDashboard(config, {}, again.fetchImpl)).toEqual({ id: 'd1', created: false });
    expect(again.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('langfuseReport on all engines', () => {
  it('filters on no engines tag', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ data: [] }));
    await langfuseReport(config, new Date(0), { engines: 'all' }, fetchImpl);
    expect(calls.every((c) => !JSON.stringify(queryOf(c.url).filters).includes('engines:'))).toBe(true);
  });
});
