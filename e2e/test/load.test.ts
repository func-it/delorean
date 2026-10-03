import { describe, expect, it } from 'vitest';
import { loadMarkdown } from '../src/load/report.ts';
import { loadCarts, type LoadReport } from '../src/load/run.ts';
import { parseDockerStats, percentile, summarize } from '../src/load/stats.ts';

describe('load bench figures', () => {
  it('takes percentiles by nearest rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 50), percentile(xs, 90), percentile(xs, 99), percentile(xs, 100)]).toEqual([
      50, 90, 99, 100,
    ]);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  it('reads docker stats, whatever the unit', () => {
    expect(parseDockerStats('{"CPUPerc":"123.45%","MemUsage":"45.5MiB / 512MiB"}')).toEqual({
      cpuPct: 123.45,
      memMiB: 45.5,
    });
    expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"1.5GiB / 2GiB"}')?.memMiB).toBe(1536);
    expect(parseDockerStats('{"CPUPerc":"--","MemUsage":"0B / 0B"}')).toBeUndefined();
    expect(parseDockerStats('not json')).toBeUndefined();
  });

  it('sums a step up', () => {
    const r = summarize(10, 20, [300, 100, 200], 1, 2, [
      { cpuPct: 50, memMiB: 40 },
      { cpuPct: 150, memMiB: 60 },
    ]);
    expect(r).toEqual({
      concurrency: 10,
      requests: 3,
      rps: 0.2,
      p50_ms: 200,
      p90_ms: 300,
      p99_ms: 300,
      max_ms: 300,
      errors: 1,
      timeouts: 2,
      cpu_pct_mean: 100,
      cpu_pct_max: 150,
      mem_mib_max: 60,
    });
  });

  it('plays the fake cases and a cart read twice, each with the status it gets', () => {
    const carts = loadCarts();
    expect(carts.some((c) => c.status === 200)).toBe(true);
    expect(carts.some((c) => c.status === 422)).toBe(true);
    expect(carts.at(-1)?.cart).toContain('\n#fake:reread');
  });

  it('writes a table per scenario', () => {
    const report = (quoter: LoadReport['quoter'], cpus: number): LoadReport => ({
      quoter,
      image: `delorean-${quoter}:load`,
      cpus,
      memory: '512m',
      fake: { latency: 'real', cpu_ms: 0 },
      warmup_s: 5,
      duration_s: 20,
      carts: 30,
      rest_mem_mib: 12.5,
      steps: [summarize(1, 20, [4000], 0, 0, [{ cpuPct: 1, memMiB: 13 }])],
      date: '2026-10-03T12:00:00Z',
      machine: {},
    });
    const md = loadMarkdown([report('go', 1), report('python', 1), report('go', 4)], '## Load');
    expect(md).toContain('### 1 CPU, 512m');
    expect(md).toContain('### 4 CPUs, 512m');
    expect(md).toContain('| Python | 1 | 0.1 | 4000 | 4000 | 4000 | 4000 | 0 | 0 | 1 | 13 |');
    expect(md).toContain('At rest: Go 12.5 MiB, Python 12.5 MiB.');
  });
});
