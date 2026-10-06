import { randomBytes } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { observe, withTraceAttributes } from '../src/telemetry/trace.ts';
import type { Case } from './cases.ts';
import { itemId, type Dataset, type LangfuseApi } from './langfuse.ts';
import type { Subject } from './subjects.ts';

/** Options of one bench. */
export interface Options {
  /** How many times every case is played. A model does not answer twice the same: one pass proves little, three show a rate. */
  runs: number;
  /** Prefixes the runs; empty, it is the variant and the time. */
  name?: string;
  description?: string;
  /**
   * Caps the spend: once the plays have cost it, no new play starts, those under way finish, and the report says
   * it was cut short. 0 or undefined is no cap.
   */
  maxUsd?: number;
  /** Langfuse, when the bench keeps its runs there. */
  langfuse?: LangfuseApi;
  /** How many cases a pass plays at once; passes run side by side too, and OpenRouter has a rate. */
  parallelism?: number;
}

/** One case in one run. */
interface Scored {
  /** The play was not started: the spend had reached the cap. */
  skipped: boolean;
  passed: boolean;
  /** Each metric's score; absent when the play was skipped, empty when it failed. */
  scores?: Record<string, number>;
  reasons: Record<string, string>;
  traceId?: string;
  /** The subject's answer, in JSON; absent when the play failed. */
  answer?: string;
}

/** One pass over the dataset. */
interface RunResult {
  name: string;
  /** The experiment, in Langfuse. */
  id: string;
  passRate: number;
  error?: string;
}

/** What a bench found, case by case and run by run. */
export interface Report {
  subject: string;
  variant: string;
  dataset: Dataset;
  runs: RunResult[];
  /** The case ids, in order. */
  cases: string[];
  /** Case id → one entry per run. */
  scores: Record<string, Scored[]>;
  metrics: string[];
  /** The metrics' own: a score passes at its threshold, not only at 1. */
  thresholds: Record<string, number>;
  cost: number;
  durationMs: number;
  /** The spend reached `maxUsd` and plays were not started: `skipped` of them. */
  cutShort: boolean;
  skipped: number;
  /** The calls to Langfuse that failed: the bench went on without them, its results computed here. */
  langfuseErrors: number;
}

const CASES_AT_ONCE = 3;

/** Plays the dataset `options.runs` times in parallel; each pass is an experiment of its own, which Langfuse compares. */
export async function run(subject: Subject, cases: readonly Case[], options: Options): Promise<Report> {
  const started = performance.now();
  if (cases.length === 0) throw new Error('no case');
  const runs = Math.max(options.runs, 1);
  const name = options.name || `${subject.variant} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const trouble = new LangfuseTrouble(subject.name);
  const lf = options.langfuse;
  let dataset: Dataset = { id: `local:${subject.name}`, name: subject.name };
  if (lf) {
    try {
      dataset = (await lf.sync(subject.name, subject.description, cases)).dataset;
    } catch (error) {
      // the results are computed here: without Langfuse, they stand
      trouble.failed('the dataset', error);
    }
  }
  const budget = new Budget(options.maxUsd ?? 0, subject);
  const report: Report = {
    subject: subject.name,
    variant: subject.variant,
    dataset,
    runs: [],
    cases: cases.map((c) => c.id),
    scores: Object.fromEntries(cases.map((c) => [c.id, [] as Scored[]])),
    metrics: subject.metrics.map((m) => m.name),
    thresholds: Object.fromEntries(subject.metrics.map((m) => [m.name, m.threshold])),
    cost: 0,
    durationMs: 0,
    cutShort: false,
    skipped: 0,
    langfuseErrors: 0,
  };
  await Promise.all(
    Array.from({ length: runs }, async (_, k) => {
      const runName = runs > 1 ? `${name} #${k + 1}` : name;
      const pass = await playPass(subject, cases, {
        name: runName,
        description: options.description ?? '',
        dataset,
        budget,
        trouble,
        parallelism: options.parallelism ?? CASES_AT_ONCE,
        ...(lf && { lf }),
      });
      report.runs[k] = { name: runName, id: pass.experiment, passRate: pass.passRate };
      for (const [id, scored] of pass.cases) {
        const row = report.scores[id];
        if (row) row[k] = scored;
      }
    }),
  );
  report.cost = subject.stats.cost;
  report.durationMs = Math.round(performance.now() - started);
  report.skipped = budget.skipped;
  report.cutShort = budget.skipped > 0;
  report.langfuseErrors = trouble.count;
  return report;
}

/** Stops starting plays once the plays have cost `max` (0: no cap). */
class Budget {
  skipped = 0;
  readonly #max: number;
  readonly #subject: Subject;

  constructor(max: number, subject: Subject) {
    this.#max = max;
    this.#subject = subject;
  }

  get max(): number {
    return this.#max;
  }

  /** Whether the cap is reached, and counts the play it holds back. */
  spent(): boolean {
    if (this.#max <= 0 || this.#subject.stats.cost < this.#max) return false;
    this.skipped++;
    return true;
  }
}

/** Logs the first Langfuse failure of a bench, and counts the others: Langfuse keeps the runs, it does not decide them. */
class LangfuseTrouble {
  count = 0;
  readonly #bench: string;

  constructor(bench: string) {
    this.#bench = bench;
  }

  failed(what: string, error: unknown): void {
    if (this.count++ > 0) return;
    const why = error instanceof Error ? error.message : String(error);
    console.error(
      `langfuse: ${what} of ${this.#bench} not sent: ${why}: the bench goes on; later failures are counted, not logged`,
    );
  }
}

interface Pass {
  experiment: string;
  passRate: number;
  cases: [string, Scored][];
}

/** One experiment over the dataset: each case played with the subject's engines, scored with its checks. */
async function playPass(
  subject: Subject,
  cases: readonly Case[],
  pass: {
    name: string;
    description: string;
    dataset: Dataset;
    budget: Budget;
    trouble: LangfuseTrouble;
    parallelism: number;
    lf?: LangfuseApi;
  },
): Promise<Pass> {
  const experiment = randomBytes(16).toString('hex');
  const scored = new Map<string, Scored>();
  const queue = cases.values();
  const worker = async () => {
    for (const c of queue) {
      if (pass.budget.spent()) {
        scored.set(c.id, {
          skipped: true,
          passed: false,
          reasons: { skipped: `not played: the spend reached $${pass.budget.max.toFixed(4)}` },
        });
        continue;
      }
      scored.set(c.id, await playCase(subject, c, experiment, pass));
    }
  };
  await Promise.all(Array.from({ length: Math.min(pass.parallelism, cases.length) }, worker));
  const played = [...scored.values()].filter((s) => !s.skipped);
  const passed = played.filter((s) => s.passed).length;
  const passRate = played.length > 0 ? passed / played.length : 0;
  if (pass.lf) {
    // a score Langfuse did not take is reported, not fatal: the pass is paid for and its results stand without it
    await pass.lf
      .score({
        name: 'pass_rate',
        value: passRate,
        datasetRunId: experiment,
        comment: `${passed}/${played.length} cases passed`,
      })
      .catch((error: unknown) => {
        pass.trouble.failed('the score pass_rate', error);
      });
  }
  return { experiment, passRate, cases: cases.map((c) => [c.id, scored.get(c.id) as Scored]) };
}

/** Plays one case under the root span of its experiment item, then scores it, and writes the scores on the trace. */
async function playCase(
  subject: Subject,
  c: Case,
  experiment: string,
  pass: { name: string; description: string; dataset: Dataset; trouble: LangfuseTrouble; lf?: LangfuseApi },
): Promise<Scored> {
  const id = itemId(subject.name, c.id);
  const input = JSON.stringify(c.input);
  const expected = JSON.stringify(c.expect);
  const traced = () =>
    withTraceAttributes(
      { traceName: `${subject.name} · ${c.id}`, tags: ['bench', subject.name, ...(c.tags ?? [])], userId: 'bench' },
      () =>
        observe(`bench ${subject.name} · ${c.id}`, 'agent', async (span) => {
          const attributes: Record<string, string> = {
            'langfuse.environment': 'bench',
            'langfuse.version': subject.variant,
            'langfuse.trace.input': input,
            'langfuse.observation.input': input,
            'langfuse.experiment.id': experiment,
            'langfuse.experiment.name': pass.name,
            'langfuse.experiment.dataset.id': pass.dataset.id,
            'langfuse.experiment.item.id': id,
            'langfuse.experiment.item.root_observation_id': trace.getActiveSpan()?.spanContext().spanId ?? '',
            'langfuse.experiment.item.expected_output': expected,
            'langfuse.experiment.metadata.variant': subject.variant,
            'langfuse.experiment.item.metadata.note': c.note,
            ...(pass.description !== '' && { 'langfuse.experiment.description': pass.description }),
          };
          trace.getActiveSpan()?.setAttributes(attributes);
          const started = performance.now();
          const played = await subject.play(c.input);
          subject.stats.played(performance.now() - started, played.usage, played.error !== undefined);
          if (played.error) {
            span.fail(played.error);
            return { played, traceId: span.traceId };
          }
          span.traceIO({ output: played.answer });
          return { played, traceId: span.traceId };
        }),
    );
  const { played, traceId } = await traced();
  const scored: Scored = { skipped: false, passed: false, scores: {}, reasons: {}, ...(traceId && { traceId }) };
  if (played.error) {
    scored.reasons.error = played.error.message;
    return scored;
  }
  scored.answer = JSON.stringify(played.answer);
  let passed = true;
  for (const metric of subject.metrics) {
    const { score, reason } = metric.check(played.answer, c);
    scored.scores = { ...scored.scores, [metric.name]: score };
    scored.reasons[metric.name] = reason;
    if (score < metric.threshold) passed = false;
  }
  scored.passed = passed;
  if (pass.lf && traceId) {
    for (const [name, value] of Object.entries(scored.scores ?? {})) {
      await pass.lf.score({ name, value, traceId, comment: scored.reasons[name] ?? '' }).catch((error: unknown) => {
        pass.trouble.failed(`the score ${name}`, error);
      });
    }
  }
  return scored;
}

/** The lowest confidence the engine gave a case across the runs, for the subjects whose answer carries one (guard, identify). */
export function minConfidence(report: Report, id: string): number | undefined {
  let low: number | undefined;
  for (const scored of report.scores[id] ?? []) {
    if (!scored.answer) continue;
    const { confidence } = JSON.parse(scored.answer) as { confidence?: unknown };
    if (typeof confidence === 'number' && (low === undefined || confidence < low)) low = confidence;
  }
  return low;
}

/** Lists, for each case, the runs it failed and why: what the terminal shows before anyone opens Langfuse. */
export function failures(report: Report): string[] {
  return report.cases.flatMap((id) =>
    (report.scores[id] ?? []).flatMap((scored, k) => {
      if (!scored.scores || scored.passed) return [];
      const why = Object.entries(scored.scores)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .flatMap(([name, score]) =>
          scored.reasons[name] && score < (report.thresholds[name] ?? 0)
            ? [`${name} ${score.toFixed(2)}: ${scored.reasons[name]}`]
            : [],
        );
      // a case the bench could not play has no score, only its error
      if (scored.reasons.error && why.length === 0) why.push(`error: ${scored.reasons.error}`);
      return [`${id}, run ${k + 1}: ${why.join(' · ')}`];
    }),
  );
}
