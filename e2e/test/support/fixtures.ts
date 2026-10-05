import { STAGES, type Health, type Quote } from '../../src/contract.ts';
import { promptVersions } from '../../src/prompts.ts';

export const FAKE_HEALTH: Health = {
  status: 'ok',
  implementation: 'typescript',
  version: '1.0.0',
  engines: 'fake',
  tracing: false,
  prompts: promptVersions(),
};

/** A faithful quote of the brief's example 5, on fake engines. */
export function quoteOfExample5(): Quote {
  const saga = (title: string, film: 'bttf_1' | 'bttf_2' | 'bttf_3') => ({
    title,
    quantity: 1,
    film,
    confidence: 1,
    unit_price_cents: 1500,
    subtotal_cents: 1500,
  });
  return {
    id: 'q_7f3a9c2e',
    currency: 'EUR',
    lines: [
      saga('Back to the Future 1', 'bttf_1'),
      saga('Back to the Future 2', 'bttf_2'),
      saga('Back to the Future 3', 'bttf_3'),
      { title: 'La chèvre', quantity: 1, film: 'other', confidence: 1, unit_price_cents: 2000, subtotal_cents: 2000 },
    ],
    subtotal_cents: 6500,
    discount: { distinct_volumes: 3, percent: 20, base_cents: 4500, amount_cents: 900 },
    total_cents: 5600,
    judge: {
      score: 1,
      threshold: 0.5,
      checks: [{ check: 'missing', label: 'the whole reading', score: 1 }],
      attempts: 1,
    },
    usage: {
      implementation: 'typescript',
      engines: 'fake',
      duration_ms: 3,
      cost_usd: 0,
      stages: STAGES.map((stage) => {
        const model = stage !== 'prepare' && stage !== 'price';
        return { stage, engine: model ? 'fake' : 'local', calls: model ? 1 : 0, duration_ms: 0, cost_usd: 0 };
      }),
    },
    created_at: '2026-10-02T13:25:01Z',
  };
}
