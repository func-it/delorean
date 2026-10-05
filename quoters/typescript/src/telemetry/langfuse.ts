import { LogLevel, configureGlobalLogger } from '@langfuse/core';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import type { Logger } from '../log.ts';

/**
 * Exports the traces and the scores to Langfuse, when the configuration names
 * a project, and does nothing otherwise: the spans of telemetry/trace.ts are
 * then no-ops. What goes wrong is said by our logger (docs/architecture.md); the
 * SDK's own logger is silenced.
 */

/** The Langfuse project the traces go to. */
export interface Langfuse {
  publicKey: string;
  secretKey: string;
  /** Where the public API answers: "https://cloud.langfuse.com", "http://localhost:24794". */
  baseUrl: string;
  /** LANGFUSE_TRACING_ENVIRONMENT and LANGFUSE_RELEASE, when set. */
  environment?: string;
  release?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Langfuse from LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
 * LANGFUSE_BASE_URL, or LANGFUSE_HOST (a URL, as the Langfuse SDKs read it).
 * Undefined when none is set; a partial setting is a configuration error,
 * said by `problem`, rather than a silent no-op.
 */
export function langfuseFromEnv(env: Env, problem: (line: string) => void): Langfuse | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY ?? '';
  const secretKey = env.LANGFUSE_SECRET_KEY ?? '';
  const baseUrl = (env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || '').replace(/\/+$/, '');
  if (publicKey === '' && secretKey === '' && baseUrl === '') return undefined;
  const missing = Object.entries({
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
    'LANGFUSE_BASE_URL (or LANGFUSE_HOST)': baseUrl,
  }).flatMap(([name, value]) => (value === '' ? [name] : []));
  if (missing.length > 0) {
    problem(`Langfuse is half configured: ${andList(missing)} missing`);
    return undefined;
  }
  if (!URL.canParse(baseUrl) || !['http:', 'https:'].includes(new URL(baseUrl).protocol)) {
    // named LANGFUSE_BASE_URL whichever variable gave it
    problem(`LANGFUSE_BASE_URL is ${JSON.stringify(baseUrl)}, not an http(s) URL`);
    return undefined;
  }
  return {
    publicKey,
    secretKey,
    baseUrl,
    ...(env.LANGFUSE_TRACING_ENVIRONMENT && { environment: env.LANGFUSE_TRACING_ENVIRONMENT }),
    ...(env.LANGFUSE_RELEASE && { release: env.LANGFUSE_RELEASE }),
  };
}

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** A measure of a quote, put on its trace: numeric, or categorical. */
export interface Score {
  name: string;
  value: number | string;
}

/** Tracing as started: whether it exports, how to score a trace, and how to flush and stop it. */
export interface Tracing {
  enabled: boolean;
  /** Puts scores on a trace; a score sent again replaces the one before. */
  score(traceId: string, scores: readonly Score[]): void;
  /** Flushes what is pending and stops; says what could not be flushed. */
  shutdown(): Promise<void>;
}

const OFF: Tracing = { enabled: false, score: () => undefined, shutdown: () => Promise.resolve() };

/** The most score batches on their way at once; past it, a quote's scores are dropped, and the log says so. */
const IN_FLIGHT = 256;

/**
 * Starts exporting to Langfuse when `langfuse` is set: the spans through
 * OpenTelemetry (its global tracer and context are registered, the resource
 * naming the service), the scores as one ingestion batch per quote.
 */
export function startTracing(
  langfuse: Langfuse | undefined,
  {
    version,
    log,
    fetch = globalThis.fetch,
    exporter,
  }: {
    version: string;
    log: Logger;
    /** How scores are posted; tests answer for Langfuse. */
    fetch?: typeof globalThis.fetch;
    /** Where spans go; Langfuse's OTLP endpoint unless a test keeps them. */
    exporter?: SpanExporter;
  },
): Tracing {
  if (!langfuse) return OFF;
  configureGlobalLogger({ level: LogLevel.NONE });
  const processor = new LangfuseSpanProcessor({
    ...(exporter && { exporter }),
    publicKey: langfuse.publicKey,
    secretKey: langfuse.secretKey,
    baseUrl: langfuse.baseUrl,
    ...(langfuse.environment !== undefined && { environment: langfuse.environment }),
    ...(langfuse.release !== undefined && { release: langfuse.release }),
    // no media in a cart: the media scan only warns at metadata kept with its type (an attempt, a total)
    mediaUploadEnabled: false,
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'delorean', 'service.version': version }),
    spanProcessors: [processor],
  });
  provider.register();

  const pending = new Set<Promise<void>>();
  const authorization = `Basic ${Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString('base64')}`;
  const send = async (traceId: string, scores: readonly Score[]) => {
    const timestamp = new Date().toISOString();
    // the event's id is the score's: Langfuse deduplicates on it, so a batch sent again changes nothing
    const batch = scores.map(({ name, value }) => ({
      id: `${traceId}-${name}`,
      type: 'score-create',
      timestamp,
      body: {
        id: `${traceId}-${name}`,
        traceId,
        name,
        value,
        dataType: typeof value === 'number' ? 'NUMERIC' : 'CATEGORICAL',
      },
    }));
    const response = await fetch(`${langfuse.baseUrl}/api/public/ingestion`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
    const answer = (await response.json().catch(() => ({}))) as { errors?: { message?: string }[] };
    if (!response.ok) throw new Error(`status ${response.status}`);
    const refused = answer.errors?.[0];
    if (refused) throw new Error(refused.message ?? 'refused');
  };

  return {
    enabled: true,
    score(traceId, scores) {
      if (pending.size >= IN_FLIGHT) {
        log.log('WARN', 'langfuse scores dropped, the queue is full', { trace_id: traceId });
        return;
      }
      const sent = send(traceId, scores)
        .catch((error: unknown) => {
          log.log('WARN', 'langfuse scores not sent', { trace_id: traceId, err: message(error) });
        })
        .finally(() => pending.delete(sent));
      pending.add(sent);
    },
    async shutdown() {
      const scores = Promise.race([
        Promise.all(pending).then(() => undefined),
        new Promise<string>((resolve) =>
          setTimeout(() => {
            resolve('timed out');
          }, 5000).unref(),
        ),
      ]);
      const [traces, unsent] = await Promise.all([provider.shutdown().then(() => undefined, message), scores]);
      if (traces !== undefined) log.log('WARN', 'traces not flushed', { err: traces });
      if (unsent !== undefined) log.log('WARN', 'scores not flushed', { err: unsent });
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
