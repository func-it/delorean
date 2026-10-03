import { describe, expect, it } from 'vitest';
import {
  fakeDelayMs,
  formatViolation,
  keyOrderViolations,
  normalizeAnswer,
  normalizeLogLine,
  PLACEHOLDER,
  probes,
  readLog,
  type Answer,
  type Probe,
} from '../src/parity.ts';

const named: Probe = { name: 'p', method: 'POST', path: '/v1/quotes', headers: { 'X-Request-Id': 'parity-001' } };
const anonymous: Probe = { name: 'p', method: 'POST', path: '/v1/quotes' };

function answer(body: string, headers: Record<string, string> = {}): Answer {
  return {
    status: 200,
    headers: { 'content-length': String(Buffer.byteLength(body)), date: 'x', ...headers },
    body,
  };
}

describe('probes', () => {
  it('have distinct names and distinct request ids', () => {
    const all = probes();
    expect(new Set(all.map((p) => p.name)).size).toBe(all.length);
    const ids = all.map((p) => p.headers?.['X-Request-Id']).filter((id) => typeof id === 'string');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('send some without a request id, and every shared quote case', () => {
    const all = probes();
    expect(all.filter((p) => p.anonymous === true).length).toBeGreaterThanOrEqual(3);
    expect(all.some((p) => p.name.startsWith('case '))).toBe(true);
  });
});

describe('normalizeAnswer', () => {
  it('replaces the quote id, created_at, durations and the implementation', () => {
    const body =
      '{"id":"q_abcdefghijklmnop","usage":{"implementation":"go","duration_ms":12,"stages":[{"duration_ms":3}]},"created_at":"2026-10-03T13:10:22.946Z"}';
    const n = normalizeAnswer(answer(body, { 'x-request-id': 'parity-001' }), 'go', named);
    expect(n.body).toBe(
      `{"id":"${PLACEHOLDER.quoteId}","usage":{"implementation":"${PLACEHOLDER.quoter}","duration_ms":"${PLACEHOLDER.ms}","stages":[{"duration_ms":"${PLACEHOLDER.ms}"}]},"created_at":"${PLACEHOLDER.time}"}`,
    );
    expect(n.headers).toEqual({ 'content-length': PLACEHOLDER.bytes, 'x-request-id': 'parity-001' });
  });

  it('leaves a time off the rule as is: microseconds, an offset', () => {
    for (const t of ['2026-10-03T13:10:22.946123Z', '2026-10-03T13:10:22.946+00:00']) {
      expect(normalizeAnswer(answer(`{"created_at":"${t}"}`), 'go', named).body).toContain(t);
    }
  });

  it('replaces a generated request id, in the header and the body, only when well formed', () => {
    const id = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const n = normalizeAnswer(answer(`{"request_id":"${id}"}`, { 'x-request-id': id }), 'go', anonymous);
    expect(n.body).toBe(`{"request_id":"${PLACEHOLDER.requestId}"}`);
    expect(n.headers['x-request-id']).toBe(PLACEHOLDER.requestId);
    const uuid = '6d1a428d-b21c-4868-87e4-57094d125bf6';
    expect(normalizeAnswer(answer('{}', { 'x-request-id': uuid }), 'go', anonymous).headers['x-request-id']).toBe(uuid);
  });

  it('keeps a Content-Length that is not the body length', () => {
    expect(
      normalizeAnswer({ status: 200, headers: { 'content-length': '3' }, body: '{}' }, 'go', named).headers,
    ).toEqual({
      'content-length': '3',
    });
  });

  it('drops transport headers', () => {
    expect(normalizeAnswer(answer('{}', { connection: 'keep-alive' }), 'go', named).headers).not.toHaveProperty(
      'connection',
    );
  });
});

describe('readLog and normalizeLogLine', () => {
  it('keeps a compact line, flags any other', () => {
    const lines = readLog('{"time":"t","level":"INFO","msg":"m"}\n{"time": "t"}\nplain\n');
    expect(lines).toEqual([{ time: 't', level: 'INFO', msg: 'm' }, { raw: '{"time": "t"}' }, { raw: 'plain' }]);
  });

  it('replaces time, ms, bytes, a generated id and the address, keeping the key order', () => {
    const line = {
      time: '2026-10-03T13:10:22.946Z',
      level: 'INFO',
      msg: 'request',
      request_id: 'GEN',
      addr: ':24799',
      ms: 3,
      bytes: 120,
    };
    expect(normalizeLogLine(line, new Set(['GEN']))).toBe(
      '{"time":"<time>","level":"INFO","msg":"request","request_id":"<request-id>","addr":"<addr>","ms":"<ms>","bytes":"<bytes>"}',
    );
    expect(normalizeLogLine({ ...line, time: '2026-10-03T08:10:22.946123-05:00' })).toContain('08:10:22.946123-05:00');
  });
});

describe('keyOrderViolations', () => {
  it('accepts the contract order, absent keys skipped', () => {
    expect(keyOrderViolations('Problem', { type: 't', title: 't', status: 400, code: 'x', request_id: 'r' })).toEqual(
      [],
    );
  });

  it('names a body out of order, nested ones included', () => {
    expect(keyOrderViolations('Problem', { title: 't', type: 't' })).toEqual([
      'Problem: title, type; the contract: type, title',
    ]);
    expect(keyOrderViolations('Quote', { judge: { score: 1, attempts: 1 } }).map((v) => v.split(':')[0])).toEqual([
      'Quote.judge',
    ]);
  });

  it('wants a map sorted', () => {
    expect(keyOrderViolations('GuardOutcome', { probabilities: { valid: 1, injection: 0 } })).toHaveLength(1);
    expect(keyOrderViolations('GuardOutcome', { probabilities: { injection: 0, valid: 1 } })).toEqual([]);
  });
});

describe('formatViolation', () => {
  it('accepts what JSON.stringify writes', () => {
    expect(formatViolation('{"a":1,"b":[0.5,1e-7]}')).toBeUndefined();
  });

  it.each([
    ['a trailing newline', '{"a":1}\n'],
    ['spaces', '{"a": 1}'],
    ['1.0', '{"a":1.0}'],
    ['an exponent with a zero', '{"a":1e-07}'],
  ])('flags %s', (_, body) => {
    expect(formatViolation(body)).toMatch(/^not canonical JSON/);
  });
});

describe('fakeDelayMs', () => {
  it('gives the vectors of docs/architecture.md', () => {
    expect(fakeDelayMs('guard', 'Heat')).toBe(385);
    expect(fakeDelayMs('parse', 'Back to the Future 1\nHeat')).toBe(1186);
    expect(fakeDelayMs('recount', 'Back to the Future 1\nHeat')).toBe(2770);
    expect(fakeDelayMs('identify', 'Heat')).toBe(316);
    expect(fakeDelayMs('judge', '')).toBe(377);
  });
});
