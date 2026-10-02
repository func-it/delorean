import { beforeAll, describe, expect, it } from 'vitest';
import { contractViolations, mediaType, type Catalog } from '../src/contract.ts';
import { client } from './support.ts';

describe('GET /v1/catalog', () => {
  let response: Response;
  let catalog: Catalog;

  beforeAll(async () => {
    const result = await client.GET('/v1/catalog');
    response = result.response;
    catalog = result.data as Catalog;
  });

  it('conforms to the contract', () => {
    expect(response.status).toBe(200);
    expect(mediaType(response)).toBe('application/json');
    expect(contractViolations('Catalog', catalog)).toEqual([]);
  });

  it('sells the three saga volumes at 15 € and any other film at 20 €', () => {
    expect(catalog.currency).toBe('EUR');
    expect(catalog.films.map(({ id, volume, unit_price_cents }) => ({ id, volume, unit_price_cents }))).toEqual([
      { id: 'bttf_1', volume: 1, unit_price_cents: 1500 },
      { id: 'bttf_2', volume: 2, unit_price_cents: 1500 },
      { id: 'bttf_3', volume: 3, unit_price_cents: 1500 },
    ]);
    expect(catalog.other_film_unit_price_cents).toBe(2000);
  });

  it('takes 10 % off the saga from 2 distinct volumes, 20 % from 3', () => {
    const tiers = catalog.saga_discounts.toSorted((a, b) => a.distinct_volumes - b.distinct_volumes);
    expect(tiers).toEqual([
      { distinct_volumes: 2, percent: 10 },
      { distinct_volumes: 3, percent: 20 },
    ]);
  });
});
