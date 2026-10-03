import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  QUOTERS,
  formatViolation,
  keyOrderViolations,
  normalizeAnswer,
  normalizeLogLine,
  perQuoter,
  probes,
  readLog,
  schemaOf,
  send,
  TIME,
  type Answer,
  type LogLine,
  type PerQuoter,
  type Probe,
} from '../src/parity.ts';

// The three quoters, started on their fake engines by scripts/e2e-parity.sh.
const urls = perQuoter<string>(process.env, 'PARITY_URLS');
const logs = perQuoter<string>(process.env, 'PARITY_LOGS');

const all = probes();
const answers = new Map<Probe, PerQuoter<Answer>>();
const logLines = {} as PerQuoter<LogLine[]>;

function requestIdOf(answer: Answer): string {
  return answer.headers['x-request-id'] ?? '';
}

/** Ids the quoters made up, replaced by a placeholder in the logs. */
function generatedIds(q: (typeof QUOTERS)[number]): Set<string> {
  const ids = new Set<string>();
  for (const [probe, a] of answers) {
    const id = requestIdOf(a[q]);
    if (id !== probe.headers?.['X-Request-Id']) ids.add(id);
  }
  return ids;
}

beforeAll(async () => {
  for (const q of QUOTERS) {
    const health = JSON.parse((await send(urls[q], { name: 'health', method: 'GET', path: '/healthz' })).body) as {
      implementation?: string;
      engines?: string;
    };
    if (health.implementation !== q || health.engines !== 'fake') {
      throw new Error(`${urls[q]} is ${health.implementation} on ${health.engines} engines, want ${q} on fake ones`);
    }
  }
  for (const probe of all) {
    const [go, typescript, python] = await Promise.all(QUOTERS.map((q) => send(urls[q], probe)));
    answers.set(probe, { go: go!, typescript: typescript!, python: python! });
  }
  // A request is logged once answered: wait for the last ones.
  const last = [...answers.values()].at(-1)!;
  for (const q of QUOTERS) {
    for (let i = 0; i < 50; i++) {
      logLines[q] = readLog(readFileSync(logs[q], 'utf8'));
      if (logLines[q].some((l) => l.request_id === requestIdOf(last[q]))) break;
      await sleep(100);
    }
  }
}, 120_000);

describe('the same answer from the three quoters', () => {
  it.each(all.map((p) => [p.name, p] as const))('%s', (_, probe) => {
    const a = answers.get(probe)!;
    const go = normalizeAnswer(a.go, 'go', probe);
    expect.soft(normalizeAnswer(a.typescript, 'typescript', probe), 'typescript, against go').toEqual(go);
    expect.soft(normalizeAnswer(a.python, 'python', probe), 'python, against go').toEqual(go);
  });
});

describe('the same log line from the three quoters', () => {
  it.each(all.map((p) => [p.name, p] as const))('%s', (_, probe) => {
    const a = answers.get(probe)!;
    const lines = (q: (typeof QUOTERS)[number]): string[] => {
      const ids = generatedIds(q);
      return logLines[q].filter((l) => l.request_id === requestIdOf(a[q])).map((l) => normalizeLogLine(l, ids));
    };
    const go = lines('go');
    expect(go).toHaveLength(1);
    expect.soft(lines('typescript'), 'typescript, against go').toEqual(go);
    expect.soft(lines('python'), 'python, against go').toEqual(go);
  });

  it('the same lines besides requests: startup', () => {
    const others = (q: (typeof QUOTERS)[number]): string[] =>
      logLines[q].filter((l) => l.msg !== 'request').map((l) => normalizeLogLine(l));
    expect.soft(others('typescript'), 'typescript, against go').toEqual(others('go'));
    expect.soft(others('python'), 'python, against go').toEqual(others('go'));
  });
});

/** The first violations, and how many more: enough to see the pattern. */
function firstOf(violations: string[], n = 8): string[] {
  return violations.length <= n ? violations : [...violations.slice(0, n), `… and ${violations.length - n} more`];
}

describe.each(QUOTERS)('%s writes as the rules say', (q) => {
  it('bodies: compact JSON, ECMAScript numbers, the contract key order', () => {
    const violations: string[] = [];
    for (const [probe, a] of answers) {
      const schema = schemaOf(probe, a[q]);
      if (schema === undefined) continue;
      const format = formatViolation(a[q].body);
      if (format !== undefined) violations.push(`${probe.name}: ${format}`);
      else violations.push(...keyOrderViolations(schema, JSON.parse(a[q].body)).map((v) => `${probe.name}: ${v}`));
    }
    expect(firstOf(violations)).toEqual([]);
  });

  it('logs: compact JSON lines, time, level and msg first, time in UTC with milliseconds', () => {
    const violations = logLines[q].flatMap((line, i) => {
      if ('raw' in line) return [`line ${i + 1} is not compact JSON: ${String(line.raw)}`];
      const keys = Object.keys(line).slice(0, 3).join();
      const out: string[] = [];
      if (keys !== 'time,level,msg') out.push(`line ${i + 1} starts with ${keys}`);
      if (typeof line.time !== 'string' || !TIME.test(line.time)) out.push(`line ${i + 1}: time ${String(line.time)}`);
      return out;
    });
    expect(firstOf(violations)).toEqual([]);
  });

  it('generated request ids: 26 base32 characters', () => {
    const ids = [...generatedIds(q)];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !/^[A-Z2-7]{26}$/.test(id))).toEqual([]);
  });
});
