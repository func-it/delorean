import type { Problem, Quote } from "@/lib/contract";

/** Example 5 of the brief, read with one doubtful identification. */
export const quote: Quote = {
  id: "q_7f3a9c2e",
  currency: "EUR",
  lines: [
    { title: "Back to the Future 1", quantity: 1, film: "bttf_1", confidence: 0.98, unit_price_cents: 1500, subtotal_cents: 1500 },
    { title: "BTTF 2", quantity: 1, film: "bttf_2", confidence: 0.95, unit_price_cents: 1500, subtotal_cents: 1500 },
    { title: "Back to the Future 3", quantity: 1, film: "bttf_3", confidence: 0.97, unit_price_cents: 1500, subtotal_cents: 1500 },
    { title: "La chèvre", quantity: 1, film: "other", confidence: 0.62, unit_price_cents: 2000, subtotal_cents: 2000 },
  ],
  subtotal_cents: 6500,
  discount: { distinct_volumes: 3, percent: 20, base_cents: 4500, amount_cents: 900 },
  total_cents: 5600,
  judge: {
    attempts: 1,
    score: 0.91,
    threshold: 0.5,
    checks: [
      { check: "asked", label: "Back to the Future 1", score: 0.99 },
      { check: "missing", label: "the whole reading", score: 0.91 },
      { check: "count", label: "other: 1 read, 1 recounted", score: 1 },
    ],
  },
  usage: { implementation: "typescript", engines: "live", duration_ms: 1840, cost_usd: 0.00213, stages: [] },
  created_at: "2026-10-02T12:00:00Z",
};

export function problem(fields: Pick<Problem, "code" | "status"> & Partial<Problem>): Problem {
  return { type: `/problems/${fields.code}`, title: "Cart rejected", ...fields };
}
