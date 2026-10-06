import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILMS, isFilm } from '../src/cart.ts';

/**
 * The cases the stage benches play: files of the repository, `cases/<folder>/<id>.json`, reviewed and
 * versioned with the code they test. `quote` is the API end to end, played by the system bench (e2e/);
 * the other folders are one stage, or a few, played alone.
 */

/** One file of `cases/<folder>/`: the input of a subject, what its answer must show, and why the case exists. */
export interface Case {
  id: string;
  /** Says in words why the case exists: which mistake it guards against. */
  note: string;
  tags?: string[];
  input: unknown;
  expect: unknown;
}

/** The repository's `cases/`, or CASES_DIR. */
export function casesDir(env: Record<string, string | undefined> = process.env): string {
  return env.CASES_DIR || fileURLToPath(new URL('../../cases', import.meta.url));
}

/** The files of a folder, in the order of their names. */
function files(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => join(dir, file));
}

/** Reads the cases of a folder, in the order of their ids. */
export function loadCases(dir: string): Case[] {
  return files(dir)
    .map(readCase)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How many case files a folder holds, unread: the API's cases are checked by the end-to-end suite. */
export function countCases(dir: string): number {
  return files(dir).length;
}

const FIELDS = ['id', 'note', 'tags', 'input', 'expect'];

/** Reads one case file: its fields and no other, and an id that is its file name. */
export function readCase(path: string): Case {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!isObject(data)) throw new Error(`${path}: a case is a JSON object`);
  const unknown = Object.keys(data).filter((key) => !FIELDS.includes(key));
  if (unknown.length > 0) throw new Error(`${path}: unknown field ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
  if (typeof data.id !== 'string') throw new Error(`${path}: id missing`);
  const want = basename(path, '.json');
  if (data.id !== want)
    throw new Error(`${path}: id ${JSON.stringify(data.id)}, the file must be named ${data.id}.json`);
  return {
    id: data.id,
    note: typeof data.note === 'string' ? data.note : '',
    ...(Array.isArray(data.tags) && { tags: data.tags as string[] }),
    input: data.input,
    expect: data.expect,
  };
}

/** The case folders that hold one stage's cases: the format of each is docs/architecture.md's. */
const STAGE_FOLDERS: Record<string, (c: Case) => string[]> = {
  guard: checkGuard,
  identify: checkIdentify,
  reading: checkReading,
  judge: checkJudge,
};

/** The case folders a stage bench plays, sorted. */
export function folders(): string[] {
  return Object.keys(STAGE_FOLDERS).toSorted();
}

/**
 * Reads every case folder under `base`, offline, and lists what is wrong: a file that is not a case, an id that is
 * not its file name, an empty note, an input or an expect off its folder's format, a film, a verdict or a check no
 * one knows. No problem, an empty list. `quote` is the end-to-end suite's, checked there.
 */
export function validate(base: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    if (entry.name === 'quote') continue;
    const check = STAGE_FOLDERS[entry.name];
    if (!check) {
      problems.push(`${dir}: no subject reads this folder (${folders().join(', ')})`);
      continue;
    }
    seen.add(entry.name);
    const paths = files(dir);
    if (paths.length === 0) problems.push(`${dir}: no case`);
    for (const path of paths) {
      let found: Case;
      try {
        found = readCase(path);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const why of [...envelope(found), ...check(found)]) problems.push(`${path}: ${why}`);
    }
  }
  for (const folder of folders()) if (!seen.has(folder)) problems.push(`${join(base, folder)}: missing`);
  return problems;
}

/** What every case carries: a note, and tags worth reading. */
function envelope(c: Case): string[] {
  const out: string[] = [];
  if (blank(c.note)) out.push('no note: say which mistake the case guards against');
  const tags = c.tags ?? [];
  tags.forEach((tag, i) => {
    if (typeof tag !== 'string' || blank(tag) || tags.slice(0, i).includes(tag)) {
      out.push(`tag ${JSON.stringify(tag)} empty or repeated`);
    }
  });
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** An input or an expect read as an object with exactly these fields, or why it is not one. */
function part(name: string, raw: unknown, fields: readonly string[]): Record<string, unknown> | string[] {
  if (raw === undefined) return [`${name} missing`];
  if (!isObject(raw)) return [`${name}: a JSON object`];
  const unknown = Object.keys(raw).filter((key) => !fields.includes(key));
  return unknown.length > 0 ? [`${name}: unknown field ${unknown.map((k) => JSON.stringify(k)).join(', ')}`] : raw;
}

/** Both parts of a case, or what is wrong with them. */
function parts(
  c: Case,
  input: readonly string[],
  expect: readonly string[],
): { input: Record<string, unknown>; expect: Record<string, unknown> } | string[] {
  const i = part('input', c.input, input);
  const e = part('expect', c.expect, expect);
  if (Array.isArray(i) || Array.isArray(e)) return [...(Array.isArray(i) ? i : []), ...(Array.isArray(e) ? e : [])];
  return { input: i, expect: e };
}

const filmList = FILMS.join(', ');

/** What is wrong with a {film: quantity} map. */
function checkFilms(films: unknown): string[] {
  if (!isObject(films)) return ['films: a {film: quantity} object'];
  return Object.entries(films).flatMap(([film, n]) => [
    ...(isFilm(film) ? [] : [`film ${JSON.stringify(film)} unknown (${filmList})`]),
    ...(Number.isInteger(n) && (n as number) >= 1 ? [] : [`film ${film}: quantity ${JSON.stringify(n)}, at least 1`]),
  ]);
}

function checkGuard(c: Case): string[] {
  const p = parts(c, ['text'], ['verdict']);
  if (Array.isArray(p)) return p;
  const out: string[] = [];
  if (blank(p.input.text)) out.push('input.text empty: the guard never sees an empty cart');
  if (!['valid', 'injection', 'invalid'].includes(p.expect.verdict as string)) {
    out.push(`verdict ${JSON.stringify(p.expect.verdict)} unknown (valid, injection, invalid)`);
  }
  return out;
}

function checkIdentify(c: Case): string[] {
  const p = parts(c, ['title'], ['film']);
  if (Array.isArray(p)) return p;
  const out: string[] = [];
  if (blank(p.input.title)) out.push('input.title empty');
  if (!isFilm(p.expect.film)) out.push(`film ${JSON.stringify(p.expect.film)} unknown (${filmList})`);
  return out;
}

function checkReading(c: Case): string[] {
  const p = parts(c, ['text'], ['films']);
  if (Array.isArray(p)) return p;
  const out: string[] = [];
  if (blank(p.input.text)) out.push('input.text empty');
  if (p.expect.films === undefined || p.expect.films === null) {
    return [...out, 'expect.films missing: {} when nothing is bought'];
  }
  return [...out, ...checkFilms(p.expect.films)];
}

function checkJudge(c: Case): string[] {
  const p = parts(c, ['text', 'lines'], ['faithful', 'check']);
  if (Array.isArray(p)) return p;
  const out: string[] = [];
  if (blank(p.input.text)) out.push('input.text empty');
  const lines = p.input.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    out.push('input.lines empty: the judge never reads an empty reading');
  } else {
    lines.forEach((line: unknown, i) => {
      const l = isObject(line) ? line : {};
      const extra = Object.keys(l).filter((key) => !['title', 'quantity', 'film'].includes(key));
      if (
        extra.length > 0 ||
        blank(l.title) ||
        !Number.isInteger(l.quantity) ||
        (l.quantity as number) < 1 ||
        !isFilm(l.film)
      ) {
        out.push(`line ${i + 1}: a title, a quantity of at least 1 and a known film (${filmList})`);
      }
    });
  }
  const { faithful, check } = p.expect;
  if (typeof faithful !== 'boolean') out.push('expect.faithful missing');
  else if (faithful && check !== undefined && check !== '') out.push('a faithful reading expects no failing check');
  if (check !== undefined && check !== '' && !['asked', 'identity', 'missing', 'count'].includes(check as string)) {
    out.push(`check ${JSON.stringify(check)} unknown (asked, identity, missing, count)`);
  }
  return out;
}
