import type { LoadReport } from './run.ts';

const NAMES: Record<string, string> = { go: 'Go', typescript: 'TypeScript', python: 'Python' };

/**
 * The comparison of load reports, one table per scenario (CPUs, fake CPU
 * time): a row per quoter and step.
 */
export function loadMarkdown(reports: LoadReport[], heading: string): string {
  const out = [heading, ''];
  const scenarios = [...new Set(reports.map((r) => `${r.cpus}|${r.fake.cpu_ms}`))];
  for (const sc of scenarios) {
    const [cpus, cpuMs] = sc.split('|');
    const rs = reports.filter((r) => `${r.cpus}|${r.fake.cpu_ms}` === sc);
    const first = rs[0];
    out.push(
      `### ${cpus} CPU${cpus === '1' ? '' : 's'}, ${first?.memory ?? ''}${cpuMs === '0' ? '' : `, ${cpuMs} ms of CPU per fake call`}`,
      '',
      '| Quoter | In flight | req/s | p50 ms | p90 ms | p99 ms | max ms | errors | timeouts | CPU % | memory MiB |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const r of rs) {
      for (const s of r.steps) {
        out.push(
          `| ${NAMES[r.quoter] ?? r.quoter} | ${s.concurrency} | ${s.rps} | ${s.p50_ms} | ${s.p90_ms} | ${s.p99_ms} | ${s.max_ms} | ` +
            `${s.errors} | ${s.timeouts} | ${s.cpu_pct_mean} | ${s.mem_mib_max} |`,
        );
      }
    }
    out.push('', `At rest: ${rs.map((r) => `${NAMES[r.quoter] ?? r.quoter} ${r.rest_mem_mib} MiB`).join(', ')}.`, '');
  }
  return out.join('\n');
}
