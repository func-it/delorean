import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchHealth } from '../src/api.ts';
import { bench, type Io } from '../src/bench/cli.ts';
import type { Report } from '../src/bench/report.ts';
import { runBench } from '../src/bench/run.ts';
import { loadQuoteCases, selectCases } from '../src/cases.ts';
import { STAGES } from '../src/contract.ts';
import { startStubQuoter, type Stub, type StubOptions } from './support/stub-quoter.ts';

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function benchAgainst(options: StubOptions = {}, runs = 1): Promise<Report> {
  stub = await startStubQuoter(options);
  const health = await fetchHealth(stub.url);
  const cases = selectCases(loadQuoteCases(), health.engines);
  return runBench({ baseUrl: stub.url, health, cases, runs, concurrency: 3 });
}

describe('runBench', () => {
  it('plays every fake case on each run, and a faithful quoter passes them all', async () => {
    const report = await benchAgainst({}, 2);
    const played = stub?.requests.filter((r) => r === 'POST /v1/quotes') ?? [];
    expect(played).toHaveLength(report.cases.length * 2);
    expect(report.requests).toBe(played.length);
    expect(report.summary.accuracy.rate).toBe(1);
    expect(report.summary.errors.hits).toBe(0);
    expect(report.summary.stages.map((s) => s.stage)).toEqual(STAGES);
    expect(report.cases.every((c) => c.passed === 2 && c.runs === 2)).toBe(true);
  });

  it('tells a mispriced cart from a misread one', async () => {
    const report = await benchAgainst({ tamper: (q) => ({ ...q, total_cents: q.total_cents + 100 }) });
    expect(report.summary.price.rate).toBe(0);
    expect(report.summary.films.rate).toBe(1);
    expect(report.summary.rejection.rate).toBe(1);
    expect(report.cases.find((c) => c.id === 'enonce-1')?.mismatches).toEqual(['total_cents: expected 3600, got 3700']);
  });

  it('counts an answer outside the contract as an error', async () => {
    const report = await benchAgainst({ tamper: (q) => ({ ...q, currency: 'USD' as 'EUR' }) });
    expect(report.summary.errors.hits).toBe(report.summary.price.total);
    expect(report.attempts.find((a) => a.case_id === 'enonce-1')?.error).toMatch(/^out of contract: \/currency/);
  });
});

describe('npm run bench', () => {
  const lines: string[] = [];
  const io: Io = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  afterEach(() => {
    lines.length = 0;
  });

  it('announces its plan, then writes the report as JSON and Markdown', async () => {
    stub = await startStubQuoter();
    const out = mkdtempSync(join(tmpdir(), 'reports-'));
    const code = await bench(['--base-url', stub.url, '--runs', '2', '--tag', 'enonce', '--out', out], {}, io);

    expect(code).toBe(0);
    expect(lines[0]).toBe(
      `About to send 10 requests (5 cases × 2 runs) to the quoter stub, fake engines, at ${stub.url}.`,
    );
    const files = readdirSync(out).sort();
    expect(files).toEqual([expect.stringMatching(/^fake-\d{8}T\d{6}Z\.json$/), expect.stringMatching(/\.md$/)]);
    const report = JSON.parse(readFileSync(join(out, files[0] ?? ''), 'utf8')) as Report;
    expect(report).toMatchObject({ tag: 'enonce', runs: 2, requests: 10, summary: { accuracy: { rate: 1 } } });
  });

  it('refuses live engines without RUN_LIVE=1, before sending a single quote', async () => {
    stub = await startStubQuoter({ health: { engines: 'live' } });
    const code = await bench(['--base-url', stub.url], {}, io);

    expect(code).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(/^About to send \d+ requests/),
      expect.stringMatching(/Set RUN_LIVE=1/),
    ]);
    expect(stub.requests).not.toContain('POST /v1/quotes');
  });

  it('refuses an option it cannot read', async () => {
    expect(await bench(['--runs', 'three'], {}, io)).toBe(2);
    expect(lines[0]).toMatch(/^--runs takes a positive integer, not "three"/);
  });
});
