import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderComparison } from './markdown.ts';
import type { Report } from './report.ts';

const USAGE = 'Usage: npm run bench:compare -- reports/a.json reports/b.json …';

/** The comparison command: prints the reports side by side as a Markdown table. */
export function compare(paths: string[], cwd: string): string {
  const reports = paths.map((path) => JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as Report);
  return renderComparison(reports);
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    // npm runs scripts from e2e/: the paths are relative to where npm was called.
    console.log(compare(paths, process.env.INIT_CWD ?? process.cwd()));
  }
}
