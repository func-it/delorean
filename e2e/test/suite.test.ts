import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadQuoteCases, selectCases } from '../src/cases.ts';
import { startStubBackend, type Stub, type StubOptions } from './support/stub-backend.ts';

const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));
const VITEST = join(E2E_DIR, 'node_modules/vitest/vitest.mjs');

interface SuiteRun {
  code: number | null;
  output: string;
  /** Test name → status, from vitest's JSON reporter. */
  results: Map<string, string>;
}

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

/** Runs `npm run e2e` against a stub backend, in a child process. */
async function runSuite(options: StubOptions = {}, env: NodeJS.ProcessEnv = {}): Promise<SuiteRun> {
  stub = await startStubBackend(options);
  const outputFile = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'results.json');
  // The child is a vitest of its own: none of this run's VITEST_* variables.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  const args = [VITEST, 'run', '--project', 'e2e', '--reporter=json', `--outputFile=${outputFile}`];

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: E2E_DIR, env: { ...inherited, RUN_LIVE: undefined, ...env, BASE_URL: stub?.url } },
      (error, stdout, stderr) => {
        const results = new Map<string, string>();
        try {
          const report = JSON.parse(readFileSync(outputFile, 'utf8')) as {
            testResults: { assertionResults: { title: string; status: string }[] }[];
          };
          for (const file of report.testResults) {
            for (const test of file.assertionResults) results.set(test.title, test.status);
          }
        } catch {
          // No report: the run stopped before any test, the output says why.
        }
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          output: stdout + stderr,
          results,
        });
      },
    );
  });
}

describe('the e2e suite, against a stub backend', { timeout: 60_000 }, () => {
  it('passes on a faithful backend, every test and every fake case played', async () => {
    const run = await runSuite();
    expect(run.code, run.output).toBe(0);
    expect(
      [...run.results.values()].every((status) => status === 'passed'),
      run.output,
    ).toBe(true);
    for (const c of selectCases(loadQuoteCases(), 'fake')) expect(run.results.get(c.id)).toBe('passed');
  });

  it('fails on a backend whose totals are off', async () => {
    const run = await runSuite({ tamper: (q) => ({ ...q, total_cents: q.total_cents - 1 }) });
    expect(run.code).not.toBe(0);
    expect(run.results.get('enonce-1')).toBe('failed');
    expect(run.results.get('echoes the X-Request-Id it receives')).toBe('failed');
    expect(run.results.get('rejects the blank cart "" as empty_cart')).toBe('passed');
  });

  it('refuses live engines without RUN_LIVE=1, before any request', async () => {
    const run = await runSuite({ health: { engines: 'live' } });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('Set RUN_LIVE=1');
    expect(stub?.requests).toEqual(['GET /healthz']);
  });
});
