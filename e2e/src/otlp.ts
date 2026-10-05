/**
 * OTLP/HTTP trace requests, as the quoters' exporters send them to Langfuse:
 * protobuf or JSON, read into one shape. Only the
 * fields Langfuse reads are kept; a small wire decoder stands in for the
 * protobuf runtime and its .proto files.
 */

/** An attribute value, typed as OTLP types it. */
export type Value =
  | { string: string }
  | { bool: boolean }
  | { int: string }
  | { double: number }
  | { bytes: string }
  | { array: Value[] }
  | { kvlist: Record<string, Value> };

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  attributes: Record<string, Value>;
  events: { name: string; attributes: Record<string, Value> }[];
  status: { code: number; message: string };
  resource: Record<string, Value>;
  scope: string;
}

// The protobuf wire format: varints, 64-bit, length-delimited, 32-bit.
interface Field {
  no: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed?: Uint8Array;
}

function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error('protobuf: truncated varint');
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    switch (wire) {
      case 0:
        out.push({ no, wire, varint: varint() });
        break;
      case 1:
        out.push({ no, wire, fixed: buf.subarray(i, i + 8) });
        i += 8;
        break;
      case 2: {
        const n = Number(varint());
        out.push({ no, wire, bytes: buf.subarray(i, i + n) });
        i += n;
        break;
      }
      case 5:
        out.push({ no, wire, fixed: buf.subarray(i, i + 4) });
        i += 4;
        break;
      default:
        throw new Error(`protobuf: wire type ${wire}`);
    }
  }
  return out;
}

const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b ?? new Uint8Array());
const hex = (b: Uint8Array | undefined): string => Buffer.from(b ?? new Uint8Array()).toString('hex');

function anyValue(buf: Uint8Array): Value {
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        return { string: text(f.bytes) };
      case 2:
        return { bool: f.varint === 1n };
      case 3:
        return { int: BigInt.asIntN(64, f.varint ?? 0n).toString() };
      case 4:
        return { double: Buffer.from(f.fixed ?? new Uint8Array(8)).readDoubleLE(0) };
      case 5:
        return { array: fields(f.bytes ?? new Uint8Array()).map((v) => anyValue(v.bytes ?? new Uint8Array())) };
      case 6:
        return { kvlist: keyValues(fields(f.bytes ?? new Uint8Array()).map((kv) => kv.bytes ?? new Uint8Array())) };
      case 7:
        return { bytes: hex(f.bytes) };
    }
  }
  return { string: '' };
}

function keyValues(list: Uint8Array[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const kv of list) {
    let key = '';
    let value: Value = { string: '' };
    for (const f of fields(kv)) {
      if (f.no === 1) key = text(f.bytes);
      if (f.no === 2) value = anyValue(f.bytes ?? new Uint8Array());
    }
    out[key] = value;
  }
  return out;
}

/** The spans of an ExportTraceServiceRequest in protobuf. */
export function decodeProtobuf(buf: Uint8Array): Span[] {
  const spans: Span[] = [];
  for (const rs of fields(buf).filter((f) => f.no === 1)) {
    let resource: Record<string, Value> = {};
    const scopes: Uint8Array[] = [];
    for (const f of fields(rs.bytes ?? new Uint8Array())) {
      if (f.no === 1) {
        resource = keyValues(
          fields(f.bytes ?? new Uint8Array())
            .filter((a) => a.no === 1)
            .map((a) => a.bytes ?? new Uint8Array()),
        );
      }
      if (f.no === 2) scopes.push(f.bytes ?? new Uint8Array());
    }
    for (const ss of scopes) {
      let scope = '';
      for (const f of fields(ss)) {
        if (f.no === 1) {
          scope = text(fields(f.bytes ?? new Uint8Array()).find((s) => s.no === 1)?.bytes);
        }
        if (f.no === 2) spans.push(span(f.bytes ?? new Uint8Array(), resource, scope));
      }
    }
  }
  return spans;
}

function span(buf: Uint8Array, resource: Record<string, Value>, scope: string): Span {
  const s: Span = {
    traceId: '',
    spanId: '',
    parentSpanId: '',
    name: '',
    kind: 0,
    attributes: {},
    events: [],
    status: { code: 0, message: '' },
    resource,
    scope,
  };
  const attrs: Uint8Array[] = [];
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        s.traceId = hex(f.bytes);
        break;
      case 2:
        s.spanId = hex(f.bytes);
        break;
      case 4:
        s.parentSpanId = hex(f.bytes);
        break;
      case 5:
        s.name = text(f.bytes);
        break;
      case 6:
        s.kind = Number(f.varint ?? 0n);
        break;
      case 9:
        attrs.push(f.bytes ?? new Uint8Array());
        break;
      case 11: {
        let name = '';
        const eventAttrs: Uint8Array[] = [];
        for (const e of fields(f.bytes ?? new Uint8Array())) {
          if (e.no === 2) name = text(e.bytes);
          if (e.no === 3) eventAttrs.push(e.bytes ?? new Uint8Array());
        }
        s.events.push({ name, attributes: keyValues(eventAttrs) });
        break;
      }
      case 15:
        for (const st of fields(f.bytes ?? new Uint8Array())) {
          if (st.no === 2) s.status.message = text(st.bytes);
          if (st.no === 3) s.status.code = Number(st.varint ?? 0n);
        }
        break;
    }
  }
  s.attributes = keyValues(attrs);
  return s;
}

interface JsonAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values?: JsonAnyValue[] };
  kvlistValue?: { values?: JsonKeyValue[] };
}
interface JsonKeyValue {
  key: string;
  value?: JsonAnyValue;
}
interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  attributes?: JsonKeyValue[];
  events?: { name: string; attributes?: JsonKeyValue[] }[];
  status?: { code?: number; message?: string };
}
interface JsonRequest {
  resourceSpans?: {
    resource?: { attributes?: JsonKeyValue[] };
    scopeSpans?: { scope?: { name?: string }; spans?: JsonSpan[] }[];
  }[];
}

function jsonValue(v: JsonAnyValue | undefined): Value {
  if (v === undefined) return { string: '' };
  if (v.stringValue !== undefined) return { string: v.stringValue };
  if (v.boolValue !== undefined) return { bool: v.boolValue };
  if (v.intValue !== undefined) return { int: String(v.intValue) };
  if (v.doubleValue !== undefined) return { double: v.doubleValue };
  if (v.bytesValue !== undefined) return { bytes: Buffer.from(v.bytesValue, 'base64').toString('hex') };
  if (v.arrayValue !== undefined) return { array: (v.arrayValue.values ?? []).map(jsonValue) };
  if (v.kvlistValue !== undefined) return { kvlist: jsonKeyValues(v.kvlistValue.values) };
  return { string: '' };
}

function jsonKeyValues(list: JsonKeyValue[] | undefined): Record<string, Value> {
  return Object.fromEntries((list ?? []).map((kv) => [kv.key, jsonValue(kv.value)]));
}

/** The spans of an ExportTraceServiceRequest in OTLP/JSON: ids in hex. */
export function decodeJson(body: string): Span[] {
  const req = JSON.parse(body) as JsonRequest;
  return (req.resourceSpans ?? []).flatMap((rs) => {
    const resource = jsonKeyValues(rs.resource?.attributes);
    return (rs.scopeSpans ?? []).flatMap((ss) =>
      (ss.spans ?? []).map((s) => ({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId ?? '',
        name: s.name,
        kind: s.kind ?? 0,
        attributes: jsonKeyValues(s.attributes),
        events: (s.events ?? []).map((e) => ({ name: e.name, attributes: jsonKeyValues(e.attributes) })),
        status: { code: s.status?.code ?? 0, message: s.status?.message ?? '' },
        resource,
        scope: ss.scope?.name ?? '',
      })),
    );
  });
}
