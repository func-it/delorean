import type { Ingestion } from './capture.ts';
import type { Span, Value } from './otlp.ts';
import { PLACEHOLDER, TIME, normalizeBody, type Quoter } from './parity.ts';

/**
 * What of a trace must match across quoters (docs/parity.md, Traces): its
 * spans as a tree, every attribute, status and event, and its scores; the
 * ids, times and durations replaced by placeholders, children in a stable
 * order (stages run side by side). Left out, because they are the
 * exporter's and Langfuse reads none of them: the resource's telemetry.sdk.*,
 * service.instance.id, process.*, host.* and os.* attributes; the
 * instrumentation scope; the SDKs' langfuse.internal.* attributes; an
 * exception event's exception.type and exception.stacktrace, which name a
 * language's own types.
 */

export interface Node {
  name: string;
  kind: number;
  status: { code: number; message: string };
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  children: Node[];
}

const EXCLUDED_RESOURCE = [/^telemetry\.sdk\./, /^service\.instance\.id$/, /^process\./, /^host\./, /^os\./];
const EXCLUDED_ATTRIBUTE = [/^langfuse\.internal\./];
const EXCLUDED_EVENT_ATTRIBUTE = [/^exception\.type$/, /^exception\.stacktrace$/, /^exception\.escaped$/];

function text(s: string, quoter: Quoter): string {
  return normalizeBody(s, quoter)
    .replace(/"q_[a-z2-7]{16}"/g, `"${PLACEHOLDER.quoteId}"`)
    .replace(/^q_[a-z2-7]{16}$/, PLACEHOLDER.quoteId)
    .replace(/"ms":\d+/g, `"ms":"${PLACEHOLDER.ms}"`)
    .replace(`quoter:${quoter}`, `quoter:${PLACEHOLDER.quoter}`);
}

/** A value as the comparison shows it: typed, so that 1 and 1.0 and "1" differ. */
function value(v: Value, quoter: Quoter): unknown {
  if ('string' in v) return text(v.string, quoter);
  if ('int' in v) return { int: v.int };
  if ('double' in v) return { double: v.double };
  if ('array' in v) return v.array.map((x) => value(x, quoter));
  if ('kvlist' in v) return Object.fromEntries(Object.entries(v.kvlist).map(([k, x]) => [k, value(x, quoter)]));
  return v;
}

function attributes(attrs: Record<string, Value>, excluded: RegExp[], quoter: Quoter): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([k]) => !excluded.some((r) => r.test(k)))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, value(v, quoter)]),
  );
}

/** The resource every span of a quoter carries, without the exporter's own attributes. */
export function resourceOf(spans: Span[], quoter: Quoter): Record<string, unknown> {
  return attributes(spans[0]?.resource ?? {}, EXCLUDED_RESOURCE, quoter);
}

/** The tree of the trace whose root is `root`, among `spans`. */
export function treeOf(root: Span, spans: Span[], quoter: Quoter): Node {
  const node = (s: Span): Node => ({
    name: s.name,
    kind: s.kind,
    status: { code: s.status.code, message: s.status.message },
    attributes: attributes(s.attributes, EXCLUDED_ATTRIBUTE, quoter),
    events: s.events.map((e) => ({
      name: e.name,
      attributes: attributes(e.attributes, EXCLUDED_EVENT_ATTRIBUTE, quoter),
    })),
    children: spans
      .filter((c) => c.traceId === s.traceId && c.parentSpanId === s.spanId)
      .map(node)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  });
  return node(root);
}

function sortKey(n: Node): string {
  return JSON.stringify([
    n.name,
    n.attributes['langfuse.observation.metadata.attempt'],
    n.attributes['langfuse.observation.input'],
  ]);
}

/** The scores of one trace, each event's ids and time replaced, by name. */
export function scoresOf(ingestion: Ingestion[], traceId: string, quoter: Quoter): unknown[] {
  return ingestion
    .filter((e) => e.body.traceId === traceId)
    .map((e) => {
      const body = { ...e.body };
      const id = body.id;
      body.id = id === `${traceId}-${String(body.name)}` ? '<trace-id>-<name>' : id;
      body.traceId = PLACEHOLDER.traceId;
      if (body.name === 'latency_ms' && typeof body.value === 'number') body.value = PLACEHOLDER.ms;
      if (typeof body.timestamp === 'string' && TIME.test(body.timestamp)) body.timestamp = PLACEHOLDER.time;
      return {
        id: e.id === id ? '<score id>' : e.id,
        type: e.type,
        timestamp: TIME.test(e.timestamp) ? PLACEHOLDER.time : e.timestamp,
        body: Object.fromEntries(
          Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? text(v, quoter) : v]),
        ),
      };
    })
    .sort((a, b) => String(a.body.name).localeCompare(String(b.body.name)));
}

/** The root span of the quote whose request id is `requestId`. */
export function rootOf(spans: Span[], requestId: string): Span | undefined {
  return spans.find(
    (s) =>
      s.parentSpanId === '' &&
      s.name === 'quote' &&
      (s.attributes['langfuse.trace.metadata.request_id'] as { string?: string } | undefined)?.string === requestId,
  );
}
