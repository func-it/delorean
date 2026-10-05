import { describe, expect, it } from 'vitest';
import type { Usage } from '../src/contract.ts';
import { renderReport } from '../src/bench/markdown.ts';
import { percentile, rate, reportName, summarize, type Report } from '../src/bench/report.ts';
import type { Attempt } from '../src/bench/run.ts';

function attempt(fields: Partial<Attempt> & Pick<Attempt, 'grade'>): Attempt {
  return { case_id: 'c', pass: 1, started_at: '2026-10-02T13:25:01.000Z', latency_ms: 10, status: 200, ...fields };
}

function usage(cost: number, guardMs: number): Usage {
  return {
    implementation: 'go',
    engines: 'live',
    duration_ms: guardMs,
    cost_usd: cost,
    stages: [
      { stage: 'prepare', engine: 'local', calls: 0, duration_ms: 1, cost_usd: 0 },
      { stage: 'guard', engine: 'jev-1.13', calls: 1, duration_ms: guardMs, cost_usd: cost },
    ],
  };
}

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 100)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10);
    expect(percentile([42], 50)).toBe(42);
  });

  it('has nothing to say about no values', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('rate', () => {
  it('counts the hits', () => {
    expect(rate([true, false, true, true])).toEqual({ hits: 3, total: 4, rate: 0.75 });
    expect(rate([])).toEqual({ hits: 0, total: 0, rate: null });
  });
});

describe('summarize', () => {
  const attempts = [
    attempt({
      latency_ms: 30,
      grade: { passed: true, price: true, films: true, mismatches: [] },
      usage: usage(0.002, 100),
    }),
    attempt({
      latency_ms: 10,
      grade: { passed: false, price: true, films: false, mismatches: ['films'] },
      usage: usage(0.004, 300),
    }),
    attempt({
      latency_ms: 20,
      status: 422,
      grade: { passed: true, rejection: true, mismatches: [] },
      usage: usage(0.003, 200),
    }),
    attempt({
      latency_ms: 40,
      status: 502,
      error: '502 engine_unavailable',
      grade: { passed: false, price: false, mismatches: ['502'] },
    }),
  ];
  const summary = summarize(attempts);

  it('splits accuracy into price, films and rejection, each over the cases that ask it', () => {
    expect(summary.accuracy).toEqual({ hits: 2, total: 4, rate: 0.5 });
    expect(summary.price).toEqual({ hits: 2, total: 3, rate: 2 / 3 });
    expect(summary.films).toEqual({ hits: 1, total: 2, rate: 0.5 });
    expect(summary.rejection).toEqual({ hits: 1, total: 1, rate: 1 });
    expect(summary.errors).toEqual({ hits: 1, total: 4, rate: 0.25 });
  });

  it('measures latency over every attempt, cost over the answers that carry a usage', () => {
    expect(summary.latency_ms).toEqual({ p50: 20, p90: 40, max: 40 });
    expect(summary.cost_usd.total).toBeCloseTo(0.009);
    expect(summary.cost_usd.per_cart).toBeCloseTo(0.003);
  });

  it('sums up each stage that ran, in pipeline order', () => {
    expect(summary.stages.map((s) => s.stage)).toEqual(['prepare', 'guard']);
    const guard = summary.stages[1];
    expect(guard).toMatchObject({ runs: 3, duration_ms: { p50: 200, p90: 300, max: 300 } });
    expect(guard?.cost_usd.mean).toBeCloseTo(0.003);
  });
});

describe('reports', () => {
  const report = (implementation: Report['implementation'], accuracy: boolean): Report => {
    const attempts = [
      attempt({
        case_id: 'enonce-1',
        grade: {
          passed: accuracy,
          price: accuracy,
          mismatches: accuracy ? [] : ['total_cents: expected 3600, got 4500'],
        },
      }),
    ];
    return {
      implementation,
      engines: 'fake',
      version: '1.0.0',
      base_url: 'http://localhost:24793',
      tag: null,
      runs: 1,
      concurrency: 4,
      started_at: '2026-10-02T13:25:01.123Z',
      finished_at: '2026-10-02T13:25:02.000Z',
      requests: 1,
      summary: summarize(attempts),
      cases: [
        {
          id: 'enonce-1',
          tags: ['fake'],
          passed: accuracy ? 1 : 0,
          runs: 1,
          mismatches: attempts[0]?.grade.mismatches ?? [],
        },
      ],
      attempts,
    };
  };

  it('names a report after its implementation, engines and start', () => {
    expect(reportName(report('go', true))).toBe('go-fake-20261002T132501Z');
  });

  it('renders a report with its failing cases', () => {
    const markdown = renderReport(report('python', false));
    expect(markdown).toContain('# System bench: python · fake');
    expect(markdown).toContain('| Price accuracy | 0.0 % (0/1) |');
    expect(markdown).toContain('| enonce-1 | 0/1 | total_cents: expected 3600, got 4500 |');
  });
});
