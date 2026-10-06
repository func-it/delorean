import type { Stage } from '../src/pipeline/ports.ts';

/** What one stage of a play took. */
export interface StageUsage {
  stage: Stage;
  calls: number;
  costUsd: number;
  ms: number;
}

/** One stage's latency, median and p90, and cost over the plays. */
export interface StageSummary {
  p50: number;
  p90: number;
  cost: number;
}

/** What the plays took, in numbers: how many answered and failed, the latency of a play and of each stage they name. */
export interface Summary {
  plays: number;
  failed: number;
  p50: number;
  p90: number;
  cost: number;
  stages: Partial<Record<Stage, StageSummary>>;
}

/**
 * Counts what a bench took: how long each play lasted (the latency is half of what separates two engines), what
 * the plays cost, and how many failed.
 */
export class Stats {
  readonly #ms: number[] = [];
  #calls = 0;
  #cost = 0;
  #failed = 0;
  /** The latency and cost of each stage a play names. */
  readonly #stages = new Map<Stage, { ms: number[]; cost: number }>();

  played(ms: number, usage: readonly StageUsage[], failed: boolean): void {
    for (const u of usage) {
      this.#calls += u.calls;
      this.#cost += u.costUsd;
      const stage = this.#stages.get(u.stage) ?? { ms: [], cost: 0 };
      stage.ms.push(u.ms);
      stage.cost += u.costUsd;
      this.#stages.set(u.stage, stage);
    }
    if (failed) this.#failed++;
    else this.#ms.push(Math.round(ms));
  }

  /** What the plays took so far. */
  summary(): Summary {
    const [p50, p90] = percentiles(this.#ms);
    const stages: Summary['stages'] = {};
    for (const [stage, { ms, cost }] of this.#stages) {
      const [stageP50, stageP90] = percentiles(ms);
      stages[stage] = { p50: stageP50, p90: stageP90, cost };
    }
    return { plays: this.#ms.length, failed: this.#failed, p50, p90, cost: this.#cost, stages };
  }

  /** What the bench has spent so far, in USD. */
  get cost(): number {
    return this.#cost;
  }

  /** One line for the report: plays, latency, model calls, cost. */
  toString(): string {
    if (this.#ms.length === 0) return `no play answered (${this.#failed} failed)`;
    const ms = this.#ms.toSorted((a, b) => a - b);
    const [p50, p90] = percentiles(ms);
    let line =
      `${ms.length} plays · median ${p50} ms · p90 ${p90} ms · max ${ms.at(-1)} ms · ${this.#calls} model calls · ` +
      `${this.#cost.toFixed(5)} USD`;
    for (const stage of ['guard', 'parse', 'recount', 'identify', 'judge'] as const) {
      const s = this.#stages.get(stage);
      if (!s) continue;
      const [stageP50, stageP90] = percentiles(s.ms);
      line += ` · ${stage} median ${stageP50} ms, p90 ${stageP90} ms, ${s.cost.toFixed(5)} USD`;
    }
    return `${line} · ${this.#failed} failed`;
  }
}

/** The median and the p90 of `ms`, as the report reads them. */
function percentiles(ms: readonly number[]): [number, number] {
  if (ms.length === 0) return [0, 0];
  const sorted = ms.toSorted((a, b) => a - b);
  return [sorted[Math.floor(sorted.length / 2)] ?? 0, sorted[Math.floor((sorted.length * 9) / 10)] ?? 0];
}
