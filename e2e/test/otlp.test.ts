import { describe, expect, it } from 'vitest';
import { decodeJson, decodeProtobuf, type Span } from '../src/otlp.ts';

// A protobuf writer just big enough to build an ExportTraceServiceRequest.
const varint = (n: bigint): number[] => {
  const out: number[] = [];
  let v = BigInt.asUintN(64, n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};
const tag = (no: number, wire: number): number[] => varint(BigInt((no << 3) | wire));
const bytes = (no: number, b: number[] | Uint8Array): number[] => [...tag(no, 2), ...varint(BigInt(b.length)), ...b];
const str = (no: number, s: string): number[] => bytes(no, [...Buffer.from(s, 'utf8')]);
const int = (no: number, n: bigint): number[] => [...tag(no, 0), ...varint(n)];
const double = (no: number, d: number): number[] => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(d);
  return [...tag(no, 1), ...b];
};
const kv = (key: string, value: number[]): number[] => [...str(1, key), ...bytes(2, value)];

const request = (): Uint8Array => {
  const span = [
    ...bytes(1, Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex')),
    ...bytes(2, Buffer.from('b7ad6b7169203331', 'hex')),
    ...str(5, 'guard'),
    ...int(6, 1n),
    ...bytes(9, kv('langfuse.observation.type', str(1, 'guardrail'))),
    ...bytes(9, kv('langfuse.observation.metadata.attempt', int(3, 2n))),
    ...bytes(9, kv('score', double(4, 0.5))),
    ...bytes(
      9,
      kv('langfuse.trace.tags', bytes(5, [...bytes(1, str(1, 'quoter:go')), ...bytes(1, str(1, 'engines:fake'))])),
    ),
    ...bytes(11, [...str(2, 'exception'), ...bytes(3, kv('exception.message', str(1, 'down')))]),
    ...bytes(15, [...str(2, 'down'), ...int(3, 2n)]),
  ];
  const scopeSpans = [...bytes(1, str(1, 'trpc.agent.go')), ...bytes(2, span)];
  const resource = bytes(1, kv('service.name', str(1, 'delorean')));
  return Uint8Array.from(bytes(1, [...bytes(1, resource), ...bytes(2, scopeSpans)]));
};

const guard: Span = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: '',
  name: 'guard',
  kind: 1,
  attributes: {
    'langfuse.observation.type': { string: 'guardrail' },
    'langfuse.observation.metadata.attempt': { int: '2' },
    score: { double: 0.5 },
    'langfuse.trace.tags': { array: [{ string: 'quoter:go' }, { string: 'engines:fake' }] },
  },
  events: [{ name: 'exception', attributes: { 'exception.message': { string: 'down' } } }],
  status: { code: 2, message: 'down' },
  resource: { 'service.name': { string: 'delorean' } },
  scope: 'trpc.agent.go',
};

describe('OTLP', () => {
  it('reads a protobuf request', () => {
    expect(decodeProtobuf(request())).toEqual([guard]);
  });

  it('reads the same request in JSON', () => {
    const json = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'delorean' } }] },
          scopeSpans: [
            {
              scope: { name: 'trpc.agent.go' },
              spans: [
                {
                  traceId: guard.traceId,
                  spanId: guard.spanId,
                  name: 'guard',
                  kind: 1,
                  attributes: [
                    { key: 'langfuse.observation.type', value: { stringValue: 'guardrail' } },
                    { key: 'langfuse.observation.metadata.attempt', value: { intValue: '2' } },
                    { key: 'score', value: { doubleValue: 0.5 } },
                    {
                      key: 'langfuse.trace.tags',
                      value: {
                        arrayValue: { values: [{ stringValue: 'quoter:go' }, { stringValue: 'engines:fake' }] },
                      },
                    },
                  ],
                  events: [
                    { name: 'exception', attributes: [{ key: 'exception.message', value: { stringValue: 'down' } }] },
                  ],
                  status: { code: 2, message: 'down' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(decodeJson(json)).toEqual([guard]);
  });
});
