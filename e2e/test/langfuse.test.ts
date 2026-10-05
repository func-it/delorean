import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { langfuseConfig, pushToLangfuse, type LangfuseConfig } from '../src/bench/langfuse.ts';
import { summarize, summarizeCases, type Report } from '../src/bench/report.ts';
import type { Attempt } from '../src/bench/run.ts';
import { loadQuoteCases } from '../src/cases.ts';

interface Received {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  attributes: { key: string; value: { stringValue: string } }[];
}

/** Answers like the Langfuse public API, and keeps every request. */
async function startLangfuseStub(options: { datasetExists?: boolean; scoreStatus?: number } = {}) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const text = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization,
        body: text ? JSON.parse(text) : undefined,
      });
      const [status, body] =
        req.method === 'GET'
          ? options.datasetExists
            ? [200, { id: 'ds_existing', name: 'quote' }]
            : [404, { message: 'not found' }]
          : path === '/api/public/v2/datasets'
            ? [200, { id: 'ds_new', name: 'quote' }]
            : path === '/api/public/scores'
              ? [options.scoreStatus ?? 200, { id: 'score' }]
              : [200, {}];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config: LangfuseConfig = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    publicKey: 'pk-lf-test',
    secretKey: 'sk-lf-test',
  };
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return { config, received, close };
}

const cases = loadQuoteCases().filter((c) => c.id === 'enonce-1' || c.id === 'enonce-2');

function benchReport(): Report {
  const attempts: Attempt[] = [1, 2].flatMap((pass) =>
    cases.map((c, i) => ({
      case_id: c.id,
      pass,
      started_at: '2026-10-02T13:25:01.000Z',
      latency_ms: 12,
      status: 200,
      outcome: { status: 200, total_cents: i === 0 ? 3600 : 3000, films: {} },
      grade:
        i === 0
          ? { passed: true, price: true, mismatches: [] }
          : { passed: false, price: false, mismatches: ['total_cents: expected 2700, got 3000'] },
    })),
  );
  return {
    implementation: 'typescript',
    engines: 'fake',
    version: '1.0.0',
    base_url: 'http://localhost:24793',
    tag: null,
    runs: 2,
    concurrency: 4,
    started_at: '2026-10-02T13:25:01.000Z',
    finished_at: '2026-10-02T13:25:02.000Z',
    requests: attempts.length,
    summary: summarize(attempts),
    cases: summarizeCases(cases, attempts),
    attempts,
  };
}

function attribute(span: OtlpSpan, key: string): string | undefined {
  return span.attributes.find((a) => a.key === key)?.value.stringValue;
}

describe('langfuseConfig', () => {
  it('is set only by its three variables together', () => {
    const env = {
      LANGFUSE_BASE_URL: 'https://langfuse.example/',
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    };
    expect(langfuseConfig(env)).toEqual({ baseUrl: 'https://langfuse.example', publicKey: 'pk', secretKey: 'sk' });
    expect(langfuseConfig({ ...env, LANGFUSE_SECRET_KEY: '' })).toBeUndefined();
    expect(langfuseConfig({})).toBeUndefined();
  });
});

describe('pushToLangfuse', () => {
  let langfuse: Awaited<ReturnType<typeof startLangfuseStub>> | undefined;
  afterEach(async () => {
    await langfuse?.close();
    langfuse = undefined;
  });

  it('syncs the cases as dataset items, then records each pass as an experiment with a score per item', async () => {
    langfuse = await startLangfuseStub();
    const result = await pushToLangfuse(benchReport(), cases, langfuse.config);
    const { received } = langfuse;

    expect(result).toEqual({
      dataset: 'quote',
      items: 2,
      experiments: ['go-fake-20261002T132501Z-pass-1', 'go-fake-20261002T132501Z-pass-2'],
    });
    expect(new Set(received.map((r) => r.authorization))).toEqual(new Set([`Basic ${btoa('pk-lf-test:sk-lf-test')}`]));
    expect(received.slice(0, 2).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/public/v2/datasets/quote',
      'POST /api/public/v2/datasets',
    ]);
    const items = received
      .filter((r) => r.path === '/api/public/dataset-items')
      .map((r) => r.body as { id: string })
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(items).toMatchObject(
      cases.map((c) => ({ datasetName: 'quote', id: `quote:${c.id}`, input: c.input, expectedOutput: c.expect })),
    );

    const traces = received.filter((r) => r.path === '/api/public/otel/v1/traces');
    expect(traces).toHaveLength(2);
    const spans = traces.flatMap(
      (r) =>
        (r.body as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans[0]?.scopeSpans[0]
          ?.spans ?? [],
    );
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(attribute(span, 'langfuse.experiment.item.root_observation_id')).toBe(span.spanId);
      expect(attribute(span, 'langfuse.experiment.dataset.id')).toBe('ds_new');
    }
    expect(attribute(spans[0] as OtlpSpan, 'langfuse.experiment.name')).toBe('go-fake-20261002T132501Z-pass-1');
    expect(attribute(spans[1] as OtlpSpan, 'langfuse.experiment.item.id')).toBe('quote:enonce-2');

    const scores = received
      .filter((r) => r.path === '/api/public/scores')
      .map((r) => r.body as Record<string, unknown>);
    expect(scores).toHaveLength(4);
    const scoreOf = (span: OtlpSpan) => scores.find((s) => s.observationId === span.spanId);
    expect(scoreOf(spans[0] as OtlpSpan)).toMatchObject({
      traceId: spans[0]?.traceId,
      name: 'correct',
      dataType: 'BOOLEAN',
      value: 1,
    });
    expect(scoreOf(spans[1] as OtlpSpan)).toMatchObject({ value: 0, comment: 'total_cents: expected 2700, got 3000' });
  });

  it('reuses the dataset, and pushes the same ids for the same report', async () => {
    langfuse = await startLangfuseStub({ datasetExists: true });
    const report = benchReport();
    await pushToLangfuse(report, cases, langfuse.config);
    await pushToLangfuse(report, cases, langfuse.config);

    expect(langfuse.received.some((r) => r.path === '/api/public/v2/datasets')).toBe(false);
    const ids = langfuse.received
      .filter((r) => r.path === '/api/public/scores')
      .map((r) => (r.body as { id: string }).id);
    expect(ids.slice(0, 4)).toEqual(ids.slice(4));
  });

  it('fails loudly when Langfuse refuses a write', async () => {
    langfuse = await startLangfuseStub({ scoreStatus: 401 });
    await expect(pushToLangfuse(benchReport(), cases, langfuse.config)).rejects.toThrow(
      /\/api\/public\/scores answered 401/,
    );
  });
});
