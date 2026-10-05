import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchHealth } from '../api.ts';
import { loadQuoteCases, selectCases } from '../cases.ts';
import { baseUrlFrom, liveRefusal } from '../config.ts';
import { langfuseConfig, pushToLangfuse } from './langfuse.ts';
import { renderReport } from './markdown.ts';
import { reportName } from './report.ts';
import { runBench } from './run.ts';

const REPORTS_DIR = fileURLToPath(new URL('../../../reports', import.meta.url));

const USAGE = `Usage: npm run bench -- [--base-url URL] [--runs N] [--tag TAG] [--concurrency N] [--out DIR]

Plays cases/quote against a quoter, N times, and writes reports/<engines>-<timestamp>.{json,md}.
Fake engines play the cases tagged "fake"; live engines play them all, and only with RUN_LIVE=1.`;

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The bench command; resolves to the exit code. */
export async function bench(argv: string[], env: NodeJS.ProcessEnv, io: Io = console): Promise<number> {
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    io.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { baseUrl, runs, concurrency, tag, out } = options;

  const health = await fetchHealth(baseUrl);
  const cases = selectCases(loadQuoteCases(), health.engines, tag);
  if (cases.length === 0) {
    io.error(`No case to play on ${health.engines} engines${tag ? ` with the tag "${tag}"` : ''}.`);
    return 1;
  }
  io.log(
    `About to send ${cases.length * runs} requests (${cases.length} cases × ${runs} runs) ` +
      `to the quoter ${health.version}, ${health.engines} engines, at ${baseUrl}.`,
  );
  const refusal = liveRefusal(health, env);
  if (refusal) {
    io.error(refusal);
    return 1;
  }

  const report = await runBench({ baseUrl, health, cases, runs, concurrency, ...(tag !== undefined && { tag }) });
  mkdirSync(out, { recursive: true });
  const path = join(out, reportName(report));
  writeFileSync(`${path}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${path}.md`, renderReport(report));
  const { accuracy, errors } = report.summary;
  io.log(`Accuracy ${accuracy.hits}/${accuracy.total}, errors ${errors.hits}. Wrote ${path}.json and .md`);

  const langfuse = langfuseConfig(env);
  if (langfuse) {
    const pushed = await pushToLangfuse(report, cases, langfuse);
    io.log(
      `Langfuse: ${pushed.items} items in dataset "${pushed.dataset}", experiments ${pushed.experiments.join(', ')}.`,
    );
  }
  return 0;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string', default: baseUrlFrom(env) },
      runs: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '4' },
      tag: { type: 'string' },
      out: { type: 'string' },
    },
  });
  return {
    baseUrl: values['base-url'],
    runs: positiveInteger('--runs', values.runs),
    concurrency: positiveInteger('--concurrency', values.concurrency),
    tag: values.tag,
    // npm runs scripts from e2e/: a path given on the command line is relative to where npm was called.
    out: values.out ? resolve(env.INIT_CWD ?? process.cwd(), values.out) : REPORTS_DIR,
  };
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} takes a positive integer, not "${value}"`);
  return number;
}

if (import.meta.main) {
  process.exitCode = await bench(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  });
}
