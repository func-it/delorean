import { describe, expect, it } from 'vitest';
import type { Quote } from '../src/contract.ts';
import { quoteViolations, usageViolations } from '../src/invariants.ts';
import { FAKE_HEALTH, quoteOfExample5 } from './support/fixtures.ts';
import { CATALOG } from './support/rules.ts';

function violations(tamper: (quote: Quote) => Quote): string[] {
  return quoteViolations(tamper(quoteOfExample5()), CATALOG);
}

const line = (q: Quote, index: number, fields: Partial<Quote['lines'][number]>) => ({
  ...q,
  lines: q.lines.map((l, i) => (i === index ? { ...l, ...fields } : l)),
});
const discount = (q: Quote, fields: Partial<Quote['discount']>) => ({ ...q, discount: { ...q.discount, ...fields } });
const judge = (q: Quote, fields: Partial<Quote['judge']>) => ({ ...q, judge: { ...q.judge, ...fields } });

describe('quoteViolations', () => {
  it('finds nothing to say about a faithful quote', () => {
    expect(quoteViolations(quoteOfExample5(), CATALOG)).toEqual([]);
  });

  it.each<[string, (q: Quote) => Quote, string]>([
    ['a unit price off the catalog', (q) => line(q, 3, { unit_price_cents: 1500 }), 'the catalog says 2000'],
    ['a line over the copies limit', (q) => line(q, 0, { quantity: 1001, subtotal_cents: 1_501_500 }), 'over limits'],
    ['a line subtotal that is not unit × quantity', (q) => line(q, 0, { quantity: 2 }), 'subtotal 1500 ≠ 1500 × 2'],
    ['a title on two lines', (q) => line(q, 1, { title: 'back to the  FUTURE 1' }), 'a second line for this title'],
    [
      'a subtotal off the lines',
      (q) => ({ ...q, subtotal_cents: 6000 }),
      'subtotal_cents 6000 ≠ Σ line subtotals 6500',
    ],
    ['volumes counted by title', (q) => discount(q, { distinct_volumes: 2 }), 'the lines hold 3 distinct volumes'],
    ['a percent off the tiers', (q) => discount(q, { percent: 10 }), 'the catalog says 20'],
    [
      'a base with other films',
      (q) => discount(q, { base_cents: 6500 }),
      'base_cents 6500 ≠ Σ saga line subtotals 4500',
    ],
    [
      'an amount off base × percent',
      (q) => discount(q, { amount_cents: 1300 }),
      'amount_cents 1300 ≠ 4500 × 20 % = 900',
    ],
    [
      'a total off subtotal − discount',
      (q) => ({ ...q, total_cents: 5200 }),
      'total_cents 5200 ≠ subtotal 6500 − discount 900',
    ],
    ['a judge score under its threshold', (q) => judge(q, { score: 0.4 }), 'under the threshold 0.5'],
    ['a judge score above its worst check', (q) => judge(q, { score: 0.9 }), 'not the worst check score'],
    ['more readings than the limit', (q) => judge(q, { attempts: 4 }), 'judge.attempts 4, a quote takes 1 to'],
  ])('flags %s', (_, tamper, message) => {
    expect(violations(tamper).join('\n')).toContain(message);
  });

  it('points at the root of a mistake the quoter carried through its arithmetic', () => {
    const found = violations((q) => ({
      ...discount(q, { percent: 10, amount_cents: 450 }),
      total_cents: 6050,
    }));
    expect(found).toEqual(['discount.percent 10 for 3 distinct volumes, the catalog says 20']);
  });
});

describe('usageViolations', () => {
  const usage = () => quoteOfExample5().usage;

  it('accepts every stage, in order, on a priced quote', () => {
    expect(usageViolations(usage(), FAKE_HEALTH, 'price')).toEqual([]);
  });

  it('accepts the stages up to the one that refused', () => {
    const refused = { ...usage(), stages: usage().stages.slice(0, 2) };
    expect(usageViolations(refused, FAKE_HEALTH, 'guard')).toEqual([]);
  });

  it('accepts a refusal by parse once the recount beside it is done too', () => {
    const refused = { ...usage(), stages: usage().stages.slice(0, 4) };
    expect(refused.stages.map((s) => s.stage)).toEqual(['prepare', 'guard', 'parse', 'recount']);
    expect(usageViolations(refused, FAKE_HEALTH, 'parse')).toEqual([]);
    const alone = { ...usage(), stages: usage().stages.slice(0, 3) };
    expect(usageViolations(alone, FAKE_HEALTH, 'parse')).toEqual([
      'usage.stages ran prepare → guard → parse, expected prepare → guard → parse → recount',
    ]);
  });

  it('lets a degraded recount have been asked once more, and only the recount be degraded', () => {
    const degraded = usage();
    const recount = degraded.stages.find((s) => s.stage === 'recount')!;
    recount.calls = 2;
    recount.degraded = true;
    expect(usageViolations(degraded, FAKE_HEALTH, 'price')).toEqual([]);
    recount.calls = 3;
    expect(usageViolations(degraded, FAKE_HEALTH, 'price')).toEqual([
      expect.stringMatching(/^usage.stages recount: fake engines make 2 free calls/),
    ]);
    // read again, a recount left out is asked again at each reading
    recount.calls = 4;
    degraded.stages.find((s) => s.stage === 'parse')!.calls = 2;
    expect(usageViolations(degraded, FAKE_HEALTH, 'price', 2)).toEqual([]);
    const judge = usage();
    judge.stages.find((s) => s.stage === 'judge')!.degraded = true;
    expect(usageViolations(judge, FAKE_HEALTH, 'price')).toEqual([
      'usage.stages judge says degraded: true; only the recount can be, and only true',
    ]);
  });

  it('adds up the calls of a cart read again, on fake engines', () => {
    const again = usage();
    for (const stage of again.stages) if (stage.stage === 'parse') stage.calls = 2;
    // the first recount that succeeds is kept: one call, however many readings
    expect(usageViolations(again, FAKE_HEALTH, 'price', 2)).toEqual([]);
    expect(usageViolations(again, FAKE_HEALTH, 'price')).toEqual([
      expect.stringMatching(/^usage.stages parse: fake engines make one free call .* in one reading/),
    ]);
    const guardTwice = usage();
    guardTwice.stages[1]!.calls = 2;
    expect(usageViolations(guardTwice, FAKE_HEALTH, 'price')).toEqual([
      expect.stringMatching(/^usage.stages guard: fake engines make one free call/),
    ]);
  });

  it('flags stages out of pipeline order', () => {
    const swapped = usage();
    swapped.stages.reverse();
    expect(usageViolations(swapped, FAKE_HEALTH, 'price')).toContainEqual(
      expect.stringMatching(/ran price → judge .* expected prepare → guard/),
    );
  });

  it('flags a usage that contradicts /healthz', () => {
    expect(usageViolations(usage(), { ...FAKE_HEALTH, implementation: 'python' }, 'price')).toEqual([
      'usage.implementation go, /healthz says python',
    ]);
  });

  it('flags a fake engine that costs, and a total that is not the sum of the stages', () => {
    const costly = usage();
    costly.stages[1]!.cost_usd = 0.01;
    const found = usageViolations(costly, FAKE_HEALTH, 'price');
    expect(found).toContainEqual(expect.stringMatching(/guard: fake engines make one free call/));
    expect(found).toContainEqual('usage.cost_usd 0 ≠ Σ stage costs 0.01');
  });

  it('lets live engines cost, but never the code stages', () => {
    const live = usage();
    live.engines = 'live';
    live.stages[1]!.cost_usd = 0.01;
    live.stages[6]!.cost_usd = 0.01;
    live.cost_usd = 0.02;
    expect(usageViolations(live, { ...FAKE_HEALTH, engines: 'live' }, 'price')).toEqual([
      'usage.stages price costs 0.01 USD, yet calls no model',
    ]);
  });
});
