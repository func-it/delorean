import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from '../src/config.ts';
import { liveEngines } from '../src/engines/live/index.ts';
import { jsonLogger } from '../src/log.ts';
import type { Engines } from '../src/pipeline/ports.ts';
import { TokenCounter } from '../src/prepare/tokens.ts';
import { loadPrompts, type Prompts } from '../src/prompts.ts';
import { startTracing, type Tracing } from '../src/telemetry/langfuse.ts';
import { casesDir, countCases, folders, loadCases, validate } from './cases.ts';
import { dryRun, type Estimate } from './dryrun.ts';
import { LangfuseApi } from './langfuse.ts';
import {
  describedRow,
  estimatedRow,
  fetchPrices,
  loadVariants,
  MODELS_API,
  rowOf,
  table,
  JEV_CALL_USD,
  type Row,
  type Variant,
} from './matrix.ts';
import { renderMarkdown, renderReport, reportJson } from './report.ts';
import { run } from './run.ts';
import { modelName, setupOf } from './setup.ts';
import { folderOf, isSubject, newSubject, SUBJECTS, subjectNames, type SubjectName } from './subjects.ts';

/** What the commands run on: the environment, where their files are, and the network and the clock, which a test replaces. */
export interface Context {
  env: Record<string, string | undefined>;
  /** What the commands print. */
  out(text: string): void;
  fetch: typeof globalThis.fetch;
  /** The engines a run plays: the live ones in production. */
  engines(config: Config, prompts: Prompts, counter: TokenCounter): Engines;
  /** Where the spans of a run go: to Langfuse when the configuration names a project. */
  tracing(config: Config): Tracing;
  casesDir: string;
  reportsDir: string;
  variantsFile: string;
  now(): Date;
}

/** A command line the bench does not take. */
export class UsageError extends Error {
  override name = 'UsageError';
}

const USAGE =
  'usage: bench list | check | run <subject> [--runs 3] [--name …] [--desc …] [--dry-run] [--max-usd 1]' +
  ' | matrix --subject parse [--variants bench/variants.yaml] [--runs 3] [--max-usd 1] [--dry-run]' +
  ' | table --subject parse [--date 2026-10-03] [--variants bench/variants.yaml]';

/** The bench's default files: the repository's cases and reports, and the variants file beside this code. */
export function defaultContext(): Context {
  return {
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    fetch: globalThis.fetch,
    engines: benchEngines,
    tracing: (config) => startTracing(config.langfuse, { version: 'bench', log: jsonLogger() }),
    casesDir: casesDir(),
    reportsDir: process.env.REPORTS_DIR || new URL('../../reports', import.meta.url).pathname,
    variantsFile: new URL('./variants.yaml', import.meta.url).pathname,
    now: () => new Date(),
  };
}

/**
 * The live engines a bench plays: a rate limit is waited out rather than failing a case, and every title is
 * identified anew: a cache would make identify free from the second run on, and the bench measures it.
 */
function benchEngines(config: Config, prompts: Prompts, counter: TokenCounter): Engines {
  return liveEngines({ ...config.live, identifyCacheSize: 0 }, prompts, undefined, counter, { attempts: 4 });
}

/** Runs one command line. */
export async function main(args: string[], ctx: Context = defaultContext()): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'list':
      list(ctx);
      return;
    case 'check':
      check(ctx);
      return;
    case 'run':
      return benchRun(rest, ctx);
    case 'matrix':
      return matrix(rest, ctx);
    case 'table':
      rebuild(rest, ctx);
      return;
    case undefined:
      throw new UsageError(USAGE);
  }
  throw new UsageError(`bench ${command}: unknown\n${USAGE}`);
}

function list(ctx: Context): void {
  for (const name of subjectNames()) {
    const cases = countCases(join(ctx.casesDir, folderOf(name)));
    ctx.out(`${name.padEnd(9)} ${String(cases).padStart(3)} cases  ${SUBJECTS[name]}`);
  }
  const quote = countCases(join(ctx.casesDir, 'quote'));
  ctx.out(
    `${'quote'.padEnd(9)} ${String(quote).padStart(3)} cases  The API end to end: played by the system bench (e2e/).`,
  );
}

/** Offline: reads every stage case, and says what is wrong with each. */
function check(ctx: Context): void {
  const problems = validate(ctx.casesDir);
  for (const p of problems) ctx.out(p);
  if (problems.length > 0) throw new Error(`${problems.length} problems in ${ctx.casesDir}`);
  const n = folders().reduce((total, f) => total + countCases(join(ctx.casesDir, f)), 0);
  ctx.out(`${n} cases in ${ctx.casesDir}, all well formed`);
}

/**
 * The service's settings as the server reads them: the models, their effort, the guard's and the judge's
 * thresholds. A dry run needs no key, so it reads them as fake engines would; a live run reads them as live ones,
 * which refuses a key that would cross the network in the clear.
 */
function configuration(ctx: Context, overrides: Record<string, string>, engines: 'fake' | 'live'): Config {
  return loadConfig({ ...ctx.env, ...overrides, ENGINES: engines });
}

/** Refuses a live run until everything it needs is set, and says all that is missing at once. */
function ready(ctx: Context, overrides: Record<string, string>): Config {
  const missing: string[] = [];
  if (ctx.env.RUN_LIVE !== '1') missing.push('RUN_LIVE=1 is not set');
  let config: Config | undefined;
  try {
    config = configuration(ctx, overrides, 'live');
  } catch (error) {
    missing.push(...(error instanceof Error ? error.message : String(error)).split('\n').slice(1));
  }
  if (missing.length > 0 || !config) {
    throw new Error(
      `bench run calls OpenRouter, and refuses to start:\n  - ${missing.join('\n  - ')}\n` +
        '--dry-run counts what it would send, offline',
    );
  }
  return config;
}

/** Langfuse, when the configuration names a project: the bench keeps its runs there; without one it keeps them in reports/. */
function langfuseOf(ctx: Context, config: Config): LangfuseApi | undefined {
  return config.langfuse && new LangfuseApi(config.langfuse, ctx.fetch);
}

const day = (ctx: Context) => ctx.now().toISOString().slice(0, 10);

function integer(value: string | undefined, flag: string, fallback: number, least: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < least) throw new UsageError(`${flag}: an integer, at least ${least}`);
  return n;
}

function amount(value: string | undefined, flag: string): number {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag}: at least 0`);
  return n;
}

/** What a flag parser says is wrong with a command line, as a usage error. */
function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function subjectOf(name: string | undefined): SubjectName {
  if (name === undefined || name.startsWith('-')) throw new UsageError(`which subject? ${subjectNames().join(', ')}`);
  if (!isSubject(name)) throw new UsageError(`subject ${JSON.stringify(name)} unknown (${subjectNames().join(', ')})`);
  return name;
}

/** Plays a subject on the live engines, the cases of its folder, and writes its report. */
async function benchRun(args: string[], ctx: Context): Promise<void> {
  const name = subjectOf(args[0]);
  const { values } = usage(() =>
    parseArgs({
      args: args.slice(1),
      strict: true,
      options: {
        runs: { type: 'string' },
        name: { type: 'string' },
        desc: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'max-usd': { type: 'string' },
      },
    }),
  );
  const runs = integer(values.runs, '--runs', 3, 1);
  const maxUsd = amount(values['max-usd'], '--max-usd');
  const cases = loadCases(join(ctx.casesDir, folderOf(name)));
  const prompts = loadPrompts(configuration(ctx, {}, 'fake').promptsDir);
  const counter = new TokenCounter();
  if (values['dry-run']) {
    const config = configuration(ctx, {}, 'fake');
    const estimate = await dryRun(name, setupOf(config, prompts), prompts, cases, (t) => counter.count(t));
    ctx.out(dryRunReport(name, estimate, cases.length, runs));
    return;
  }

  const config = ready(ctx, {});
  const langfuse = langfuseOf(ctx, config);
  const tracing = ctx.tracing(config);
  const engines = ctx.engines(config, prompts, counter);
  try {
    const subject = newSubject(name, { ...setupOf(config, prompts), engines });
    ctx.out(`${name} · ${subject.variant} · ${cases.length} cases × ${runs} runs`);
    const report = await run(subject, cases, {
      runs,
      maxUsd,
      ...(values.name !== undefined && { name: values.name }),
      ...(values.desc !== undefined && { description: values.desc }),
      ...(langfuse && { langfuse }),
    });
    ctx.out(renderReport(report, langfuse));
    ctx.out(String(subject.stats));
    const dir = join(ctx.reportsDir, day(ctx));
    mkdirSync(dir, { recursive: true });
    const stamp = ctx.now().toISOString().slice(11, 19).replaceAll(':', '');
    const summary = subject.stats.summary();
    const base = join(dir, `${name}-run-${stamp}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(reportJson(report, summary, { date: day(ctx) }), null, 2)}\n`);
    writeFileSync(`${base}.md`, renderMarkdown(report, summary, { date: day(ctx), line: String(subject.stats) }));
    ctx.out(`written to ${base}.json and ${base}.md`);
  } finally {
    await engines.close?.();
    await tracing.shutdown();
  }
}

/** What a dry run says: the calls and the tokens a run would send, offline. */
function dryRunReport(name: string, est: Estimate, cases: number, runs: number): string {
  let about = est.approximate ? ' — titles counted from the cases; the parse and the recount may read more' : '';
  if (est.readAttempts > 1) {
    about += `; one reading a case, and a reading the judge refuses is read again, up to ${est.readAttempts}`;
  }
  return [
    `${name} · ${est.variant} · ${cases} cases × ${runs} runs — dry run, nothing sent`,
    `  calls:  ${est.jev * runs} Jev, ${est.llm * runs} LLM${about}`,
    `  input:  ≈ ${est.tokens * runs} tokens (o200k_base; Jev's tokenizer is not published)`,
  ].join('\n');
}

/** What a variant is, for its row: the parse's model, effort and strategy, and whether it answers on this machine. */
function describe(v: Variant, config: Config): Row {
  const host = new URL(config.live.parseBaseUrl).hostname;
  return describedRow({
    variant: v.name,
    model: modelName(config.live.parseModel),
    effort: config.live.parseEffort,
    strategy: 'parse + identify',
    local: ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host),
  });
}

/** What a matrix's table compares: the subject, the date, the cases and runs, and the prompts' versions. */
function heading(subject: string, date: string, cases: number, runs: number, prompts: Prompts, dry: boolean): string {
  const what = dry
    ? "estimated by a dry run, nothing sent: prices from OpenRouter's models API, reasoning tokens not " +
      `counted, a local model free, Jev at $${JEV_CALL_USD.toFixed(5)} a call`
    : 'measured';
  return (
    `# ${subject} matrix, ${date}\n\n${cases} cases × ${runs} runs, ${what}.\n` +
    `Prompts: parse ${prompts.parse.version}, identify ${prompts.identify.version}.\n`
  );
}

function writeTable(ctx: Context, path: string, head: string, rows: readonly Row[]): void {
  const doc = `${head}\n${table(rows)}`;
  ctx.out(`\n${doc}`);
  ctx.out(`written to ${path}`);
  writeFileSync(path, doc);
}

/**
 * Benches a subject once per variant of a variants file, and compares them in one table, printed and written as
 * Markdown beside each variant's JSON report (reports/<date>/). `--dry-run` runs nothing: it estimates each
 * variant's cost from the token counts and OpenRouter's prices.
 */
async function matrix(args: string[], ctx: Context): Promise<void> {
  const { values } = usage(() =>
    parseArgs({
      args,
      strict: true,
      options: {
        subject: { type: 'string' },
        variants: { type: 'string' },
        runs: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'max-usd': { type: 'string' },
      },
    }),
  );
  const name = subjectOf(values.subject ?? 'parse');
  const runs = integer(values.runs, '--runs', 3, 1);
  const maxUsd = amount(values['max-usd'], '--max-usd');
  const variants = loadVariants(values.variants ?? ctx.variantsFile);
  const cases = loadCases(join(ctx.casesDir, folderOf(name)));
  const date = day(ctx);
  const dir = join(ctx.reportsDir, date);
  mkdirSync(dir, { recursive: true });
  const base = configuration(ctx, {}, 'fake');
  const prompts = loadPrompts(base.promptsDir);
  const counter = new TokenCounter();

  if (values['dry-run']) {
    const prices = await fetchPrices(ctx.env.MODELS_API || MODELS_API, ctx.fetch);
    const rows: Row[] = [];
    for (const v of variants) {
      const config = configuration(ctx, v.env, 'fake');
      const row = describe(v, config);
      const price = prices.get(config.live.parseModel);
      if (!row.local) {
        if (!price) throw new Error(`variant ${v.name}: ${config.live.parseModel} is not on OpenRouter`);
        if (!price.structuredOutputs) {
          throw new Error(`variant ${v.name}: ${config.live.parseModel} cannot answer under a strict JSON schema`);
        }
      }
      const estimate = await dryRun(name, setupOf(config, prompts), prompts, cases, (t) => counter.count(t));
      rows.push(
        estimatedRow(row, estimate, cases.length, price ?? { prompt: 0, completion: 0, structuredOutputs: true }),
      );
    }
    const total = rows.reduce((sum, r) => sum + r.cost_per_cart_usd * cases.length * runs, 0);
    const head = `${heading(name, date, cases.length, runs, prompts, true)}≈ $${total.toFixed(4)} for the whole matrix.\n`;
    writeTable(ctx, join(dir, `${name}-matrix-dry-run.md`), head, rows);
    return;
  }

  ready(ctx, {});
  const head = heading(name, date, cases.length, runs, prompts, false);
  const rows: Row[] = [];
  let spent = 0;
  for (const v of variants) {
    const config = ready(ctx, v.env);
    if (maxUsd > 0 && spent >= maxUsd) {
      // the cap is reached: the variant is not started
      rows.push({ ...describe(v, config), cut_short: true });
      ctx.out(`${v.name}: not run, the matrix has spent $${spent.toFixed(4)} of $${maxUsd.toFixed(4)}`);
      continue;
    }
    const langfuse = langfuseOf(ctx, config);
    const tracing = ctx.tracing(config);
    const engines = ctx.engines(config, prompts, counter);
    try {
      const subject = newSubject(name, { ...setupOf(config, prompts), engines });
      ctx.out(`${v.name} · ${name} · ${subject.variant} · ${cases.length} cases × ${runs} runs`);
      const report = await run(subject, cases, {
        runs,
        name: v.name,
        ...(v.note && { description: v.note }),
        ...(maxUsd > 0 && { maxUsd: maxUsd - spent }),
        ...(langfuse && { langfuse }),
      });
      spent += report.cost;
      if (report.langfuseErrors > 0) {
        ctx.out(`${v.name}: ${report.langfuseErrors} calls to Langfuse failed; its results are computed here`);
      }
      const summary = subject.stats.summary();
      const row = rowOf(describe(v, config), report, summary);
      rows.push(row);
      writeFileSync(
        join(dir, `${name}-${v.name}.json`),
        `${JSON.stringify(
          {
            subject: name,
            variant: v.name,
            note: v.note ?? '',
            env: v.env,
            tested: subject.variant,
            row,
            summary,
            cases: report.cases.map((id) => {
              const scores = report.scores[id] ?? [];
              return {
                id,
                passed: scores.filter((s) => s.passed).length,
                runs: scores.length,
                reasons: scores.filter((s) => !s.passed).flatMap((s) => Object.values(s.reasons)),
              };
            }),
          },
          null,
          2,
        )}\n`,
      );
      // the table so far, after each variant: a matrix stopped half-way leaves the comparison of what it ran
      writeFileSync(join(dir, `${name}-matrix.md`), `${head}\n${table(rows)}`);
    } finally {
      await engines.close?.();
      await tracing.shutdown();
    }
  }
  writeTable(ctx, join(dir, `${name}-matrix.md`), head, rows);
}

/** The version of a stage as a variant's `tested` line names it: "parse 1a2b3c4d". */
const PROMPT_VERSION = /(parse|identify|judge|guard|recount) [0-9a-f]{8}/g;

/**
 * Rebuilds a matrix's table from the variants' JSON reports of a day (reports/<date>/<subject>-<variant>.json),
 * offline, in the order of the variants file: a matrix that stopped half-way, or that wrote no table, is compared
 * all the same.
 */
function rebuild(args: string[], ctx: Context): void {
  const { values } = usage(() =>
    parseArgs({
      args,
      strict: true,
      options: { subject: { type: 'string' }, date: { type: 'string' }, variants: { type: 'string' } },
    }),
  );
  const name = subjectOf(values.subject ?? 'parse');
  const date = values.date ?? day(ctx);
  const variants = loadVariants(values.variants ?? ctx.variantsFile);
  const dir = join(ctx.reportsDir, date);
  const rows: Row[] = [];
  let cases = 0;
  let runs = 0;
  const versions = new Set<string>();
  for (const v of variants) {
    let text: string;
    try {
      text = readFileSync(join(dir, `${name}-${v.name}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // not run
      throw error;
    }
    const r = JSON.parse(text) as { row: Row; tested?: string; cases?: { runs: number }[] };
    rows.push(r.row);
    cases = Math.max(cases, r.cases?.length ?? 0);
    runs = Math.max(runs, r.cases?.[0]?.runs ?? 0);
    for (const m of (r.tested ?? '').match(PROMPT_VERSION) ?? []) versions.add(m);
  }
  if (rows.length === 0) throw new Error(`no report of ${name} in ${dir}`);
  const head =
    `# ${name} matrix, ${date}\n\n${cases} cases × ${runs} runs, measured; ${rows.length} of ${variants.length} variants run.\n` +
    `Prompts: ${[...versions].join(', ')}.\n`;
  writeTable(ctx, join(dir, `${name}-matrix.md`), head, rows);
}
