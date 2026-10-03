import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool, errors as undiciErrors } from 'undici';
import { loadQuoteCases } from '../cases.ts';
import type { Quoter } from '../parity.ts';
import { parseDockerStats, summarize, type DockerSample, type StepResult } from './stats.ts';

const exec = promisify(execFile);

/** Where each quoter's image listens, as shipped. */
export const IMAGE_PORT: Record<Quoter, number> = { go: 24791, typescript: 24793, python: 24792 };

export interface LoadCart {
  name: string;
  cart: string;
  /** The status the fakes answer it with. */
  status: number;
}

/**
 * The carts of every step, in a fixed order: the shared quote cases the fake
 * engines play (priced and refused), and a cart read twice.
 */
export function loadCarts(): LoadCart[] {
  const fake = loadQuoteCases().filter((c) => c.tags.includes('fake'));
  return [
    ...fake.map((c) => ({ name: c.id, cart: c.input.cart, status: c.expect.status })),
    { name: 'read-again', cart: 'Back to the Future 2\nRonin\n#fake:reread', status: 200 },
  ];
}

export interface Scenario {
  quoter: Quoter;
  image: string;
  cpus: number;
  memory: string;
  fakeCpuMs: number;
  /** In-flight requests of each step. */
  steps: number[];
  warmupS: number;
  durationS: number;
  /** The host port the container is published on. */
  port: number;
}

export interface LoadReport {
  quoter: Quoter;
  image: string;
  cpus: number;
  memory: string;
  fake: { latency: 'real'; cpu_ms: number };
  warmup_s: number;
  duration_s: number;
  carts: number;
  /** The container's memory once started, before any request. */
  rest_mem_mib: number;
  steps: StepResult[];
  date: string;
  machine: Record<string, string | number>;
}

const CONTAINER = 'delorean-load';

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { maxBuffer: 16 << 20 });
  return stdout.trim();
}

/** Samples `docker stats` of the container until stopped. */
function sampleStats(): { samples: { at: number; s: DockerSample }[]; stop: () => void } {
  const samples: { at: number; s: DockerSample }[] = [];
  const child = spawn('docker', ['stats', '--format', '{{json .}}', CONTAINER]);
  let buf = '';
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      // docker stats redraws the terminal: strip its escape codes
      const s = parseDockerStats(
        line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '').trim(),
      );
      if (s) samples.push({ at: Date.now(), s });
    }
  });
  return { samples, stop: () => child.kill('SIGTERM') };
}

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`${base}/healthz never answered`);
}

/**
 * One step: `concurrency` clients in a closed loop, each sending the next
 * cart as soon as its last one is answered, for warm-up then the measured
 * window. A request counts in the window it is answered in.
 */
async function step(
  base: string,
  carts: LoadCart[],
  concurrency: number,
  warmupS: number,
  durationS: number,
  stats: { at: number; s: DockerSample }[],
  log: (line: string) => void,
): Promise<StepResult> {
  const pool = new Pool(base, { connections: concurrency, headersTimeout: 60_000, bodyTimeout: 60_000 });
  const start = Date.now();
  const measureFrom = start + warmupS * 1000;
  const end = measureFrom + durationS * 1000;
  const latencies: number[] = [];
  let errors = 0;
  let timeouts = 0;
  let next = 0;
  const client = async (): Promise<void> => {
    while (Date.now() < end) {
      const c = carts[next++ % carts.length];
      if (!c) return;
      const t0 = performance.now();
      let ok = false;
      let timedOut = false;
      try {
        const res = await pool.request({
          path: '/v1/quotes',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cart: c.cart }),
        });
        await res.body.text();
        ok = res.statusCode === c.status;
      } catch (err) {
        timedOut = err instanceof undiciErrors.HeadersTimeoutError || err instanceof undiciErrors.BodyTimeoutError;
      }
      const done = Date.now();
      if (done >= measureFrom && done <= end) {
        if (timedOut) timeouts++;
        else if (!ok) errors++;
        else latencies.push(performance.now() - t0);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, client));
  await pool.close();
  const window = stats.filter((x) => x.at >= measureFrom && x.at <= end).map((x) => x.s);
  const r = summarize(concurrency, durationS, latencies, errors, timeouts, window);
  log(
    `  ${String(concurrency).padStart(3)} in flight: ${r.rps} req/s, p50 ${r.p50_ms} ms, p99 ${r.p99_ms} ms, ` +
      `${r.errors} errors, ${r.timeouts} timeouts, CPU ${r.cpu_pct_mean} %, ${r.mem_mib_max} MiB`,
  );
  return r;
}

/** Runs the quoter of `s` alone in its image, limited, through every step. */
export async function runScenario(s: Scenario, log: (line: string) => void): Promise<LoadReport> {
  await docker('rm', '-f', CONTAINER).catch(() => '');
  await docker(
    'run', '-d', '--rm', '--name', CONTAINER,
    '--cpus', String(s.cpus), '--memory', s.memory, '--memory-swap', s.memory,
    '-p', `127.0.0.1:${s.port}:${IMAGE_PORT[s.quoter]}`,
    '-e', 'ENGINES=fake', '-e', 'FAKE_LATENCY=real', '-e', `FAKE_CPU_MS=${s.fakeCpuMs}`,
    s.image,
  ); // prettier-ignore
  const base = `http://127.0.0.1:${s.port}`;
  try {
    await waitHealthy(base);
    const stats = sampleStats();
    try {
      await sleep(4000); // at rest: started, no request yet
      const rest = stats.samples.map((x) => x.s.memMiB);
      const carts = loadCarts();
      const steps: StepResult[] = [];
      for (const n of s.steps) steps.push(await step(base, carts, n, s.warmupS, s.durationS, stats.samples, log));
      return {
        quoter: s.quoter,
        image: s.image,
        cpus: s.cpus,
        memory: s.memory,
        fake: { latency: 'real', cpu_ms: s.fakeCpuMs },
        warmup_s: s.warmupS,
        duration_s: s.durationS,
        carts: carts.length,
        rest_mem_mib: Math.round((rest.at(-1) ?? 0) * 10) / 10,
        steps,
        date: new Date().toISOString(),
        machine: {},
      };
    } finally {
      stats.stop();
    }
  } finally {
    await docker('rm', '-f', CONTAINER).catch(() => '');
  }
}
