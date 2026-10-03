import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { QUOTERS, type Quoter } from '../parity.ts';
import { loadMarkdown } from './report.ts';
import { runScenario, type LoadReport } from './run.ts';

/**
 * The load bench: each quoter alone in its image, limited in CPUs and
 * memory, on fake engines that take a model's time (FAKE_LATENCY=real), under
 * 1 to 200 requests in flight. No model is called. docs/testing.md, "Load
 * bench".
 *
 *   node src/load/cli.ts [--quoters go,typescript,python] [--cpus 1,4] [--memory 512m]
 *     [--steps 1,10,50,100,200] [--warmup 5] [--duration 20] [--fake-cpu-ms 0] [--out ../reports/load/<date>]
 *   node src/load/cli.ts --table ../reports/load/<date>      # the Markdown table again, from the reports
 */

const exec = promisify(execFile);
const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const { values } = parseArgs({
  options: {
    quoters: { type: 'string', default: QUOTERS.join(',') },
    cpus: { type: 'string', default: '1,4' },
    memory: { type: 'string', default: '512m' },
    steps: { type: 'string', default: '1,10,50,100,200' },
    warmup: { type: 'string', default: '5' },
    duration: { type: 'string', default: '20' },
    'fake-cpu-ms': { type: 'string', default: '0' },
    out: { type: 'string', default: join('..', 'reports', 'load', new Date().toISOString().slice(0, 10)) },
    port: { type: 'string', default: '24796' },
    table: { type: 'string' },
  },
});

function writeTable(dir: string): void {
  const reports = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as LoadReport)
    .sort(
      (a, b) =>
        a.cpus - b.cpus || a.fake.cpu_ms - b.fake.cpu_ms || QUOTERS.indexOf(a.quoter) - QUOTERS.indexOf(b.quoter),
    );
  const m = reports[0]?.machine ?? {};
  const heading =
    `## Load bench, ${reports[0]?.date.slice(0, 10) ?? ''}\n\n` +
    `Fake engines with FAKE_LATENCY=real; ${reports[0]?.warmup_s ?? 0} s of warm-up then ${reports[0]?.duration_s ?? 0} s per step; ` +
    `${reports[0]?.carts ?? 0} carts in turn. ${String(m.cpu ?? '')}, Docker ${String(m.docker_cpus ?? '')} CPUs; ` +
    `host load ${String(m.host_load ?? '')} at the start.`;
  writeFileSync(join(dir, 'load.md'), loadMarkdown(reports, heading));
  console.log(join(dir, 'load.md'));
}

if (values.table !== undefined) {
  writeTable(values.table);
} else {
  mkdirSync(values.out, { recursive: true });
  const info = JSON.parse((await exec('docker', ['info', '--format', '{{json .}}'])).stdout) as {
    NCPU?: number;
    MemTotal?: number;
    ServerVersion?: string;
  };
  const machine = {
    cpu: cpus()[0]?.model ?? '',
    host_cpus: cpus().length,
    host_mem_gib: Math.round(totalmem() / 2 ** 30),
    docker: info.ServerVersion ?? '',
    docker_cpus: info.NCPU ?? 0,
    docker_mem_gib: Math.round((info.MemTotal ?? 0) / 2 ** 30),
    host_load: loadavg()
      .map((l) => l.toFixed(1))
      .join(' '),
  };
  for (const cpusN of list(values.cpus).map(Number)) {
    for (const q of list(values.quoters) as Quoter[]) {
      const cpuMs = Number(values['fake-cpu-ms']);
      console.log(`${q}, ${cpusN} CPU, ${values.memory}${cpuMs ? `, ${cpuMs} ms CPU per fake call` : ''}`);
      const report = await runScenario(
        {
          quoter: q,
          image: `delorean-${q}:load`,
          cpus: cpusN,
          memory: values.memory,
          fakeCpuMs: cpuMs,
          steps: list(values.steps).map(Number),
          warmupS: Number(values.warmup),
          durationS: Number(values.duration),
          port: Number(values.port),
        },
        (line) => {
          console.log(line);
        },
      );
      report.machine = machine;
      const suffix = cpuMs ? `-cpu${cpuMs}` : '';
      writeFileSync(join(values.out, `${q}-${cpusN}${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  writeTable(values.out);
}
