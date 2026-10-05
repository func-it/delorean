import { api, postQuote, type Api } from '../api.ts';
import type { QuoteCase } from '../cases.ts';
import { contractViolations, type Health, type Problem, type Quote, type Usage } from '../contract.ts';
import { failedGrade, grade, outcomeOf, type Grade, type Outcome } from '../outcome.ts';
import { mapConcurrent } from './pool.ts';
import { summarize, summarizeCases, type Report } from './report.ts';

/** Above the quoter's own budget (REQUEST_TIMEOUT, 15 s by default). */
const REQUEST_TIMEOUT_MS = 60_000;

/** One case played once. */
export interface Attempt {
  case_id: string;
  /** Which pass over the cases, from 1. */
  pass: number;
  started_at: string;
  latency_ms: number;
  /** Absent when no HTTP answer came back. */
  status?: number;
  /** No answer, a 5xx, or an answer outside the contract. */
  error?: string;
  outcome?: Outcome;
  grade: Grade;
  usage?: Usage;
}

export interface BenchOptions {
  baseUrl: string;
  health: Health;
  cases: QuoteCase[];
  runs: number;
  concurrency: number;
  tag?: string;
}

/** Plays every case `runs` times, pass after pass, and sums it up. */
export async function runBench(options: BenchOptions): Promise<Report> {
  const { baseUrl, health, cases, runs, concurrency } = options;
  const client = api(baseUrl);
  const jobs = Array.from({ length: runs }, (_, i) => cases.map((c) => ({ c, pass: i + 1 }))).flat();

  const startedAt = new Date();
  const attempts = await mapConcurrent(jobs, concurrency, ({ c, pass }) => attempt(client, c, pass));
  return {
    implementation: health.implementation,
    engines: health.engines,
    version: health.version,
    base_url: baseUrl,
    tag: options.tag ?? null,
    runs,
    concurrency,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    requests: attempts.length,
    summary: summarize(attempts),
    cases: summarizeCases(cases, attempts),
    attempts,
  };
}

async function attempt(client: Api, c: QuoteCase, pass: number): Promise<Attempt> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const failed = (error: string, status?: number): Attempt => ({
    case_id: c.id,
    pass,
    started_at: startedAt,
    latency_ms: elapsed(),
    ...(status !== undefined && { status }),
    error,
    grade: failedGrade(c.expect, error),
  });

  let exchange;
  try {
    exchange = await postQuote(client, c.input.cart, {}, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    return failed(`no answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { status } = exchange.response;
  const violations = contractViolations(status === 200 ? 'Quote' : 'Problem', exchange.body);
  if (violations.length > 0) return failed(`out of contract: ${violations.join('; ')}`, status);

  const body = exchange.body as Quote | Problem;
  const outcome = outcomeOf(status, body);
  return {
    case_id: c.id,
    pass,
    started_at: startedAt,
    latency_ms: elapsed(),
    status,
    // a 5xx is a failure of the service, unless the case expects exactly it (a refusal to retry)
    ...(status >= 500 &&
      !('code' in c.expect && c.expect.status === status && c.expect.code === outcome.code) && {
        error: `${status} ${outcome.code ?? ''}`.trim(),
      }),
    outcome,
    grade: grade(c.expect, outcome),
    ...(body.usage && { usage: body.usage }),
  };
}
