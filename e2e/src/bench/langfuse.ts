import { createHash } from 'node:crypto';
import type { QuoteCase } from '../cases.ts';
import { mapConcurrent } from './pool.ts';
import { reportName, type Report } from './report.ts';
import type { Attempt } from './run.ts';

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export interface PushResult {
  dataset: string;
  items: number;
  experiments: string[];
}

const DATASET = 'quote';
const CONCURRENCY = 4;

/** Langfuse is optional: configured only when its three variables are set. */
export function langfuseConfig(env: NodeJS.ProcessEnv): LangfuseConfig | undefined {
  const { LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = env;
  if (!baseUrl || !publicKey || !secretKey) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), publicKey, secretKey };
}

/**
 * Pushes a bench report to Langfuse, through its public API:
 * - the cases become the items of the dataset `quote`, upserted on the id `quote:<case id>`;
 * - each pass over the cases becomes an experiment: one OpenTelemetry trace
 *   per item (the v4 way to record experiment items), and a `correct` score on it.
 * Every id derives from the report, so pushing the same report twice changes nothing.
 */
export async function pushToLangfuse(
  report: Report,
  cases: QuoteCase[],
  config: LangfuseConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) =>
    fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const existing = await call('GET', `/api/public/v2/datasets/${DATASET}`);
  const dataset = await ok<{ id: string }>(
    existing.status === 404
      ? await call('POST', '/api/public/v2/datasets', {
          name: DATASET,
          description: 'cases/quote: free-text carts and what the API must answer.',
        })
      : existing,
  );

  await mapConcurrent(cases, CONCURRENCY, async (c) =>
    ok(
      await call('POST', '/api/public/dataset-items', {
        datasetName: DATASET,
        id: itemId(c),
        input: c.input,
        expectedOutput: c.expect,
        metadata: { note: c.note, tags: c.tags },
      }),
    ),
  );

  const byId = new Map(cases.map((c) => [c.id, c]));
  const experiments: string[] = [];
  for (let pass = 1; pass <= report.runs; pass++) {
    const experiment = `${reportName(report)}-pass-${pass}`;
    const items = report.attempts
      .filter((a) => a.pass === pass)
      .flatMap((a) => {
        const c = byId.get(a.case_id);
        return c ? [{ attempt: a, c, ids: itemIds(experiment, c) }] : [];
      });

    await ok(
      await call('POST', '/api/public/otel/v1/traces', {
        resourceSpans: [
          {
            resource: { attributes: attributes({ 'service.name': 'delorean-bench' }) },
            scopeSpans: [
              {
                scope: { name: 'delorean-bench' },
                spans: items.map(({ attempt, c, ids }) => ({
                  ...ids,
                  name: `quote ${c.id}`,
                  kind: 1,
                  startTimeUnixNano: nanos(Date.parse(attempt.started_at)),
                  endTimeUnixNano: nanos(Date.parse(attempt.started_at) + attempt.latency_ms),
                  attributes: attributes({
                    'langfuse.experiment.id': experiment,
                    'langfuse.experiment.name': experiment,
                    'langfuse.experiment.dataset.id': dataset.id,
                    'langfuse.experiment.description': `${report.engines} engines, pass ${pass} of ${report.runs}`,
                    'langfuse.experiment.metadata.engines': report.engines,
                    'langfuse.experiment.metadata.version': report.version,
                    'langfuse.experiment.item.id': itemId(c),
                    'langfuse.experiment.item.root_observation_id': ids.spanId,
                    'langfuse.experiment.item.expected_output': JSON.stringify(c.expect),
                    'langfuse.experiment.item.metadata.latency_ms': `${attempt.latency_ms}`,
                    'langfuse.experiment.item.metadata.cost_usd': `${attempt.usage?.cost_usd ?? 0}`,
                    'langfuse.experiment.item.metadata.quoter_trace_id': attempt.usage?.trace_id ?? '',
                    'langfuse.observation.input': JSON.stringify(c.input),
                    'langfuse.observation.output': JSON.stringify(attempt.outcome ?? { error: attempt.error }),
                  }),
                })),
              },
            ],
          },
        ],
      }),
    );

    await mapConcurrent(items, CONCURRENCY, async ({ attempt, ids }) =>
      ok(await call('POST', '/api/public/scores', score(attempt, ids))),
    );
    experiments.push(experiment);
  }
  return { dataset: DATASET, items: cases.length, experiments };
}

function itemId(c: QuoteCase): string {
  return `${DATASET}:${c.id}`;
}

/** Stable OpenTelemetry ids for one item of one experiment. */
function itemIds(experiment: string, c: QuoteCase): { traceId: string; spanId: string } {
  const digest = createHash('sha256').update(`${experiment}\n${c.id}`).digest('hex');
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) };
}

function score(attempt: Attempt, { traceId, spanId }: { traceId: string; spanId: string }) {
  const { passed, mismatches } = attempt.grade;
  return {
    id: `${traceId}-correct`,
    traceId,
    observationId: spanId,
    name: 'correct',
    dataType: 'BOOLEAN',
    value: passed ? 1 : 0,
    ...(mismatches.length > 0 && { comment: mismatches.join('\n') }),
  };
}

function attributes(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

function nanos(epochMs: number): string {
  return (BigInt(epochMs) * 1_000_000n).toString();
}

async function ok<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Langfuse ${response.url} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
