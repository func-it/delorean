import { startObservation } from '@langfuse/tracing';
import { context, trace } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/log.ts';
import { startTracing } from '../src/telemetry/langfuse.ts';

// The scores go as one ingestion batch per quote; what fails is said by our
// logger. No test reaches a Langfuse.

const langfuse = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://langfuse.test' };

/** Spans kept in memory, never posted: no test waits on a network. `failing`, it refuses them and its shutdown fails. */
function exporter(failing = false): SpanExporter & { spans: ReadableSpan[] } {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    export(batch, done) {
      if (!failing) spans.push(...batch);
      done({ code: failing ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
    },
    shutdown: () => (failing ? Promise.reject(new Error('offline')) : Promise.resolve()),
    forceFlush: () => Promise.resolve(),
  };
}

function logger() {
  const lines: { level: string; msg: string; attributes: Record<string, unknown> }[] = [];
  const log: Logger = { log: (level, msg, attributes = {}) => lines.push({ level, msg, attributes }) };
  return { lines, log };
}

afterEach(() => {
  trace.disable();
  context.disable();
});

describe('scores', () => {
  it("sends a quote's scores as one ingestion batch, each with the id <trace>-<name>", async () => {
    const sent: {
      url: string;
      headers: Headers;
      body: { batch: { id: string; type: string; body: Record<string, unknown> }[] };
    }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) as never });
      return Promise.resolve(new Response('{"successes":[],"errors":[]}', { status: 207 }));
    }) as typeof globalThis.fetch;
    const { lines, log } = logger();
    const tracing = startTracing(langfuse, { version: 'test', log, fetch, exporter: exporter() });
    tracing.score('t1', [
      { name: 'cost_usd', value: 0.002 },
      { name: 'outcome', value: 'priced' },
    ]);
    await tracing.shutdown();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://langfuse.test/api/public/ingestion');
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`);
    expect(sent[0]?.body.batch.map((e) => e.id)).toEqual(['t1-cost_usd', 't1-outcome']);
    expect(sent[0]?.body.batch.map((e) => [e.type, e.body])).toEqual([
      ['score-create', { id: 't1-cost_usd', traceId: 't1', name: 'cost_usd', value: 0.002, dataType: 'NUMERIC' }],
      ['score-create', { id: 't1-outcome', traceId: 't1', name: 'outcome', value: 'priced', dataType: 'CATEGORICAL' }],
    ]);
    expect(lines).toEqual([]);
  });

  it.each([
    [
      'refused',
      () =>
        new Response('{"successes":[],"errors":[{"id":"x","status":400,"message":"invalid score"}]}', { status: 207 }),
      'invalid score',
    ],
    ['an error status', () => new Response('{}', { status: 401 }), 'status 401'],
  ])('says a batch %s as langfuse scores not sent', async (_, answer, err) => {
    const { lines, log } = logger();
    const tracing = startTracing(langfuse, {
      version: 'test',
      log,
      fetch: () => Promise.resolve(answer()),
    });
    tracing.score('t1', [{ name: 'outcome', value: 'priced' }]);
    await tracing.shutdown();
    expect(lines).toContainEqual({
      level: 'WARN',
      msg: 'langfuse scores not sent',
      attributes: { trace_id: 't1', err },
    });
  });
});

describe('spans', () => {
  it('name the service delorean, at its version, and set no SDK logger of their own', async () => {
    const { lines, log } = logger();
    const tracing = startTracing(langfuse, { version: '1.2.3', log, exporter: exporter(true) });
    const span = startObservation('probe');
    span.end();
    const resource = (span.otelSpan as unknown as { resource: { attributes: Record<string, unknown> } }).resource;
    expect(resource.attributes).toMatchObject({ 'service.name': 'delorean', 'service.version': '1.2.3' });
    await tracing.shutdown();
    // the export failed: said in our words, once, and nothing else
    expect(lines).toEqual([
      { level: 'WARN', msg: 'traces not flushed', attributes: { err: 'BatchSpanProcessor: span export failed' } },
    ]);
  });
});
