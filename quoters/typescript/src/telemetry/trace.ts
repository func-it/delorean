import {
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
} from '@langfuse/tracing';
import { SpanStatusCode, context, isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * Spans, as Langfuse reads them (docs/architecture.md, "Usage, cost and
 * traces"): the quote, an agent; a span per stage, typed for Langfuse's
 * graph; a generation per model call. They go through OpenTelemetry's global tracer,
 * a no-op until telemetry starts: code that traces never checks whether
 * tracing is on, and the span of the caller is found in the async context,
 * as Go finds it in a context.Context.
 */

/** The kinds of observation delorean opens. */
export type ObservationType = 'agent' | 'span' | 'guardrail' | 'chain' | 'evaluator' | 'generation';

/** An open observation. */
export interface Observation {
  /** The trace this observation belongs to, when traces are exported. */
  readonly traceId: string | undefined;
  update(attributes: LangfuseGenerationAttributes): void;
  /** Sets the input or the output of the observation, and of the whole trace. */
  traceIO(io: { input: unknown } | { output: unknown }): void;
  /** Sets the whole trace's metadata, kept with their types. */
  traceAttributes(attributes: { metadata: Record<string, unknown> }): void;
  /** Marks the observation failed: an error, not a refusal. */
  fail(error: unknown): void;
  /** Marks a failure that did not fail the quote (a degraded stage): a warning, not an error. */
  warn(error: unknown): void;
}

/** Metadata kept as typed attributes (an attempt is the number 2, as Go writes it, not the string "2"). */
type Metadata = Record<string, number | string>;

const start = {
  agent: (name: string) => startObservation(name, {}, { asType: 'agent' }),
  chain: (name: string) => startObservation(name, {}, { asType: 'chain' }),
  span: (name: string) => startObservation(name),
  guardrail: (name: string) => startObservation(name, {}, { asType: 'guardrail' }),
  evaluator: (name: string) => startObservation(name, {}, { asType: 'evaluator' }),
  generation: (name: string) => startObservation(name, {}, { asType: 'generation' }),
};

/** Runs `fn` in a new observation, the current one's child, and ends it when `fn` settles. */
export async function observe<T>(
  name: string,
  type: ObservationType,
  fn: (observation: Observation) => Promise<T>,
  metadata?: Metadata,
): Promise<T> {
  const observation = start[type](name);
  const span = observation.otelSpan;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    span.setAttribute(`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.${key}`, value);
  }
  const traceId = isSpanContextValid(span.spanContext()) ? observation.traceId : undefined;
  try {
    return await context.with(trace.setSpan(context.active(), span), () =>
      fn({
        traceId,
        update: (attributes) => observation.update(attributes),
        traceIO: (io) => {
          observation.update(io);
          const [key, value] =
            'input' in io
              ? [LangfuseOtelSpanAttributes.TRACE_INPUT, io.input]
              : [LangfuseOtelSpanAttributes.TRACE_OUTPUT, io.output];
          span.setAttribute(key, typeof value === 'string' ? value : JSON.stringify(value));
        },
        traceAttributes: ({ metadata }) => {
          for (const [key, value] of Object.entries(metadata)) {
            const attribute = `${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`;
            span.setAttribute(
              attribute,
              typeof value === 'number' || typeof value === 'string' ? value : JSON.stringify(value),
            );
          }
        },
        fail: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Error) span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          observation.update({ level: 'ERROR', statusMessage: message });
        },
        warn: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Error) span.recordException(error);
          observation.update({ level: 'WARNING', statusMessage: `degraded: ${message}` });
        },
      }),
    );
  } finally {
    observation.end();
  }
}

/** Adds metadata, kept with its type, to the current observation: what an engine tells of its stage. */
export function annotate(metadata: Metadata): void {
  const span = trace.getActiveSpan();
  for (const [key, value] of Object.entries(metadata)) {
    span?.setAttribute(`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.${key}`, value);
  }
}

/** Who asks, and what the trace is named, on the current span and every span `fn` opens. */
export function withTraceAttributes<T>(
  attributes: { traceName: string; tags: string[]; userId?: string; sessionId?: string },
  fn: () => T,
): T {
  return propagateAttributes(attributes, fn);
}
