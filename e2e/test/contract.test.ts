import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATH, contractViolations, mediaType } from '../src/contract.ts';
import { FAKE_HEALTH, quoteOfExample5 } from './support/fixtures.ts';
import { CATALOG } from './support/rules.ts';

describe('contractViolations', () => {
  it('accepts bodies that follow the contract', () => {
    expect(contractViolations('Health', FAKE_HEALTH)).toEqual([]);
    expect(contractViolations('Catalog', CATALOG)).toEqual([]);
    expect(contractViolations('Quote', quoteOfExample5())).toEqual([]);
    expect(
      contractViolations('Problem', {
        type: '/problems/no_film',
        title: 'Cart rejected',
        status: 422,
        code: 'no_film',
      }),
    ).toEqual([]);
  });

  it('follows $refs between component schemas', () => {
    const quote = { ...quoteOfExample5(), lines: [{ ...quoteOfExample5().lines[0], film: 'bttf_4' }] };
    expect(contractViolations('Quote', quote)).toEqual([
      expect.stringMatching(/^\/lines\/0\/film must be equal to one of the allowed values/),
    ]);
  });

  it('rejects properties the contract does not declare', () => {
    expect(contractViolations('Health', { ...FAKE_HEALTH, uptime: 3 })).toEqual([
      expect.stringMatching(/must NOT have additional properties .*uptime/),
    ]);
  });

  it('checks formats, as JSON Schema 2020-12 asks', () => {
    expect(contractViolations('Quote', { ...quoteOfExample5(), created_at: 'yesterday' })).toEqual([
      expect.stringMatching(/^\/created_at must match format "date-time"/),
    ]);
  });
});

describe('mediaType', () => {
  it('drops parameters and case', () => {
    const response = new Response('{}', { headers: { 'content-type': 'Application/Problem+JSON; charset=utf-8' } });
    expect(mediaType(response)).toBe('application/problem+json');
  });
});

describe('src/generated/openapi.ts', () => {
  it('is generated from the current contract (npm run generate)', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'openapi-')), 'openapi.ts');
    const bin = fileURLToPath(new URL('../node_modules/.bin/openapi-typescript', import.meta.url));
    await promisify(execFile)(bin, [fileURLToPath(CONTRACT_PATH), '-o', out]);
    const committed = new URL('../src/generated/openapi.ts', import.meta.url);
    expect(await readFile(committed, 'utf8')).toBe(await readFile(out, 'utf8'));
  });
});
