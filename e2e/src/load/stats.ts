/** The figures of a load step, computed offline: percentiles and docker stats. */

/** The p-th percentile of `sorted` (ascending), nearest rank; 0 when empty. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

/** One line of `docker stats --format '{{json .}}'`, read. */
export interface DockerSample {
  /** Percent of one CPU: 250 is two and a half. */
  cpuPct: number;
  /** The container's memory, in MiB, as the cgroup counts it. */
  memMiB: number;
}

const UNITS: Record<string, number> = {
  B: 1 / 1024 / 1024,
  KiB: 1 / 1024,
  kB: 1000 / 1024 / 1024,
  MiB: 1,
  MB: 1e6 / 1024 / 1024,
  GiB: 1024,
  GB: 1e9 / 1024 / 1024,
};

/** Reads `docker stats` JSON: {"CPUPerc":"12.34%","MemUsage":"45.6MiB / 512MiB",…}. */
export function parseDockerStats(line: string): DockerSample | undefined {
  let v: { CPUPerc?: string; MemUsage?: string };
  try {
    v = JSON.parse(line) as typeof v;
  } catch {
    return undefined;
  }
  const cpu = Number.parseFloat((v.CPUPerc ?? '').replace('%', ''));
  const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(v.MemUsage ?? '');
  const unit = m?.[2] !== undefined ? UNITS[m[2]] : undefined;
  if (Number.isNaN(cpu) || m === null || unit === undefined) return undefined;
  return { cpuPct: cpu, memMiB: Number.parseFloat(m[1] ?? '0') * unit };
}

export interface StepResult {
  concurrency: number;
  /** Requests completed in the measured window. */
  requests: number;
  rps: number;
  p50_ms: number;
  p90_ms: number;
  p99_ms: number;
  max_ms: number;
  /** Answers with an unexpected status, and failed connections. */
  errors: number;
  /** Requests that got no answer before the client's timeout. */
  timeouts: number;
  cpu_pct_mean: number;
  cpu_pct_max: number;
  mem_mib_max: number;
}

/** A step's figures from its latencies (ms), its counts and the docker samples of its window. */
export function summarize(
  concurrency: number,
  seconds: number,
  latencies: number[],
  errors: number,
  timeouts: number,
  samples: DockerSample[],
): StepResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;
  const cpu = samples.map((s) => s.cpuPct);
  return {
    concurrency,
    requests: sorted.length,
    rps: round(sorted.length / seconds),
    p50_ms: Math.round(percentile(sorted, 50)),
    p90_ms: Math.round(percentile(sorted, 90)),
    p99_ms: Math.round(percentile(sorted, 99)),
    max_ms: Math.round(sorted.at(-1) ?? 0),
    errors,
    timeouts,
    cpu_pct_mean: round(cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0),
    cpu_pct_max: round(Math.max(0, ...cpu)),
    mem_mib_max: round(Math.max(0, ...samples.map((s) => s.memMiB))),
  };
}
