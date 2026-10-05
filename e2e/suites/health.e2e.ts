import { describe, expect, it } from 'vitest';
import { contractViolations, mediaType } from '../src/contract.ts';
import { promptVersions } from '../src/prompts.ts';
import { client } from './support.ts';

describe('GET /healthz', () => {
  it('says which engines answer, per the contract', async () => {
    const { data, response } = await client.GET('/healthz');
    expect(response.status).toBe(200);
    expect(mediaType(response)).toBe('application/json');
    expect(contractViolations('Health', data)).toEqual([]);
  });

  it("serves the versions of the repository's prompts", async () => {
    const { data } = await client.GET('/healthz');
    expect(data?.prompts, 'the quoter runs other prompts than prompts/').toEqual(promptVersions());
  });
});
