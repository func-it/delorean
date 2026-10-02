import { describe, expect, it } from 'vitest';
import { contractViolations, mediaType } from '../src/contract.ts';
import { client } from './support.ts';

describe('GET /healthz', () => {
  it('says which implementation and engines answer, per the contract', async () => {
    const { data, response } = await client.GET('/healthz');
    expect(response.status).toBe(200);
    expect(mediaType(response)).toBe('application/json');
    expect(contractViolations('Health', data)).toEqual([]);
  });
});
