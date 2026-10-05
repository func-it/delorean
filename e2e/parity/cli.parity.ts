import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  FAKE_PROFILE_MS,
  QUOTERS,
  cleanEnv,
  fakeDelayMs,
  normalizeLogLine,
  perQuoter,
  readLog,
  send,
  type PerQuoter,
  type Quoter,
} from '../src/parity.ts';

// How to run each quoter's program, e.g. {"go": ["/tmp/x/delorean"], …}.
const commands = perQuoter<string[]>(process.env, 'PARITY_COMMANDS');
// A free port for the quoters this file starts, one at a time.
const port = process.env.PARITY_SPARE_PORT ?? '24796';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `quoter` with `args` and `env` on top of a clean environment; a
 * program still running after `ms` gets SIGTERM, as does one whose output
 * `stopWhen` accepts, after `then` has run.
 */
function run(
  quoter: Quoter,
  args: string[],
  env: Record<string, string>,
  opts: { ms?: number; stopWhen?: (stdout: string) => boolean; then?: () => Promise<unknown> } = {},
): Promise<Run> {
  const [program, ...base] = commands[quoter];
  return new Promise((resolve, reject) => {
    const child = spawn(program!, [...base, ...args], { env: cleanEnv(process.env, { PORT: port, ...env }) });
    let stdout = '';
    let stderr = '';
    let stopping = false;
    const stop = (): void => {
      if (!stopping) {
        stopping = true;
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(stop, opts.ms ?? 8_000);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      if (!stopping && opts.stopWhen?.(stdout)) {
        stopping = true;
        void (opts.then?.() ?? Promise.resolve()).catch(() => undefined).finally(() => child.kill('SIGTERM'));
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A run with its log lines' times and durations replaced; other output as is. */
function normalize(r: Run): Run {
  const lines = (text: string): string =>
    readLog(text)
      .map((l) => ('raw' in l ? String(l.raw) : normalizeLogLine(l)))
      .join('\n');
  return { code: r.code, stdout: lines(r.stdout), stderr: lines(r.stderr) };
}

async function runAll(args: string[], env: Record<string, string> = {}): Promise<PerQuoter<Run>> {
  const out = {} as PerQuoter<Run>;
  for (const q of QUOTERS) out[q] = normalize(await run(q, args, env, { ms: 4_000 }));
  return out;
}

function expectSame(runs: PerQuoter<Run>): void {
  expect.soft(runs.typescript, 'typescript, against go').toEqual(runs.go);
  expect.soft(runs.python, 'python, against go').toEqual(runs.go);
}

const FAKE = { ENGINES: 'fake' };

describe('the healthcheck command', () => {
  it.each([
    ['nothing listening', { PORT: port }],
    ['a port that is not one', { PORT: 'abc' }],
  ])('exits 1 with %s, and says why in one line on stderr', async (_, env) => {
    for (const q of QUOTERS) {
      const r = await run(q, ['healthcheck'], env, { ms: 6_000 });
      expect(r.code, q).toBe(1);
      expect(r.stdout, q).toBe('');
      expect(r.stderr.trim().split('\n'), q).toHaveLength(1);
    }
  });
});

describe('the same commands', () => {
  it.each([
    ['version', ['version']],
    ['tokenizer', ['tokenizer']],
    ['an unknown command', ['help']],
    ['a flag', ['--help']],
    ['an extra argument', ['serve', 'extra']],
  ])('%s', async (_, args) => {
    const runs = await runAll(args, FAKE);
    expect(runs.go.code).not.toBeNull();
    expectSame(runs);
  });
});

describe('the same configuration errors', () => {
  it.each([
    ['live engines without a key', { ENGINES: 'live' }],
    ['unknown engines', { ENGINES: 'FAKE' }],
    ['a port not a number', { ...FAKE, PORT: 'abc' }],
    ['a port out of range', { ...FAKE, PORT: '70000' }],
    ['an unknown effort', { ...FAKE, PARSE_EFFORT: 'max' }],
    ['an unknown recount effort', { ...FAKE, RECOUNT_EFFORT: 'x' }],
    ['no reading', { ...FAKE, READ_ATTEMPTS: '0' }],
    ['a negative cache', { ...FAKE, IDENTIFY_CACHE_SIZE: '-1' }],
    ['a base URL not http', { ...FAKE, PARSE_BASE_URL: 'ftp://x' }],
    ['a recount base URL not a URL', { ...FAKE, RECOUNT_BASE_URL: 'nowhere' }],
    ['PARSE_IDENTIFIES not a boolean', { ...FAKE, PARSE_IDENTIFIES: 'maybe' }],
    ['a confidence over 1', { ...FAKE, GUARD_MIN_CONFIDENCE: '2' }],
    ['a confidence not a number', { ...FAKE, GUARD_MIN_CONFIDENCE: 'x' }],
    ['a negative threshold', { ...FAKE, JUDGE_THRESHOLD: '-1' }],
    ['no body', { ...FAKE, MAX_BODY_BYTES: '0' }],
    ['a timeout without its unit', { ...FAKE, REQUEST_TIMEOUT: '30' }],
    ['a model timeout over the recount timeout', { ...FAKE, MODEL_TIMEOUT: '10s' }],
    ['a recount timeout over the request timeout', { ...FAKE, RECOUNT_TIMEOUT: '20s' }],
    ['an unknown fake latency', { ...FAKE, FAKE_LATENCY: 'slow' }],
    ['a fake CPU time not a number', { ...FAKE, FAKE_CPU_MS: 'x' }],
    ['a negative fake CPU time', { ...FAKE, FAKE_CPU_MS: '-1' }],
    ['two wrong variables', { ...FAKE, PORT: 'x', READ_ATTEMPTS: '0' }],
    ['Langfuse half set', { ...FAKE, LANGFUSE_PUBLIC_KEY: 'pk' }],
    ['Langfuse without its address', { ...FAKE, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }],
  ])('%s', async (_, env) => {
    const runs = await runAll([], env);
    expect(runs.go.code).toBe(1);
    expectSame(runs);
  });
});

describe('the same life', () => {
  it('starts, answers, stops on SIGTERM', async () => {
    const runs = {} as PerQuoter<Run>;
    for (const q of QUOTERS) {
      const r = await run(q, ['serve'], FAKE, {
        ms: 15_000,
        // Listening means ready: the request is sent at once, never retried.
        stopWhen: (out) => readLog(out).some((l) => l.msg === 'listening' || String(l.raw).includes('listening')),
        then: () =>
          send(`http://127.0.0.1:${port}`, {
            name: 'life',
            method: 'GET',
            path: '/healthz',
            headers: { 'X-Request-Id': 'parity-life' },
          }),
      });
      runs[q] = normalize(r);
    }
    expect(runs.go.code).toBe(0);
    expectSame(runs);
  }, 60_000);
});

describe('the same fake latency', () => {
  // One reading each, so that a stage's duration is one call's.
  const carts = ['Back to the Future 1\nHeat', 'Ronin', 'Back to the Future 2\nBack to the Future 3\nLa chèvre'];

  it.each(QUOTERS)(
    '%s: every stage takes the time of the profile, give or take 20 %%',
    async (q) => {
      const answers: string[] = [];
      await run(
        q,
        ['serve'],
        { ...FAKE, FAKE_LATENCY: 'real' },
        {
          ms: 30_000,
          stopWhen: (out) => readLog(out).some((l) => l.msg === 'listening' || String(l.raw).includes('listening')),
          then: () =>
            Promise.all(
              carts.map(async (cart) => {
                const a = await send(`http://127.0.0.1:${port}`, {
                  name: 'latency',
                  method: 'POST',
                  path: '/v1/quotes',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cart }),
                });
                answers.push(a.body);
              }),
            ),
        },
      );
      expect(answers).toHaveLength(carts.length);
      const misses: string[] = [];
      for (const body of answers) {
        const quote = JSON.parse(body) as {
          lines: { title: string }[];
          usage: { stages: { stage: string; duration_ms: number }[] };
        };
        const cart = carts.find((c) => quote.lines.every((l) => c.includes(l.title))) ?? '';
        const input: Record<keyof typeof FAKE_PROFILE_MS, string> = {
          guard: cart,
          parse: cart,
          recount: cart,
          identify: quote.lines.map((l) => l.title).join('\n'),
          judge: cart,
        };
        for (const s of quote.usage.stages) {
          if (!(s.stage in FAKE_PROFILE_MS)) continue;
          const want = fakeDelayMs(s.stage as keyof typeof FAKE_PROFILE_MS, input[s.stage as keyof typeof input]);
          // a timer fires at its time or a little after; the stage adds its own work
          if (s.duration_ms < want - 1 || s.duration_ms > want + 80) {
            misses.push(`${JSON.stringify(cart)} ${s.stage}: ${s.duration_ms} ms, want ${want}`);
          }
        }
      }
      expect(misses).toEqual([]);
    },
    60_000,
  );
});
