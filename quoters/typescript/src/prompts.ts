import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILMS, type Film } from './cart.ts';
import type { Check } from './pipeline/ports.ts';

/**
 * Every word put to a model lives in the repository's `prompts/`, versioned by
 * the hash of each file, so that a measure says what it tested. They are read
 * once, at startup, and checked: a prompt file
 * that lacks a question stops the service before it answers anyone.
 */

/** A question as Jev takes it: `criteria` holds `true` and `false` for a noul, one entry per option for a choice. */
export interface Question {
  key: string;
  kind: 'noul' | 'choice';
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}

/** A file a reader reads with: parse.json. */
export interface ReadingPrompt {
  instruction: string;
  /** The JSON schema of a reading, asked of the model and checked on its answer. */
  schema: Readonly<Record<string, unknown>>;
  /** The fence around the customer's message in the user turn. */
  message: { before: string; after: string };
  /**
   * The turn that asks for a new reading: `turn` with `{findings}` replaced
   * by one `finding` line per failing check, `{check}`, `{label}` and
   * `{meaning}` filled in, the meaning from `meanings`.
   */
  retry: { turn: string; finding: string; meanings: Readonly<Record<Check, string>> };
  version: string;
}

export interface Prompts {
  guard: { order: Question; steer: Question; version: string };
  /** The parse's and the recount's file. */
  parse: ReadingPrompt;
  identify: { film: Question; version: string };
  judge: {
    asked: Question;
    identity: Question;
    missing: Question;
    /** What a title was identified as, in the judge's words. */
    films: Readonly<Record<Film, string>>;
    version: string;
  };
}

const CHECKS: readonly Check[] = ['asked', 'identity', 'missing', 'count'];

/** The repository's prompts, from this file's place in it. */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url));

/** Reads and checks the prompt files of `dir`. Throws, naming the file and the field, on anything off. */
export function loadPrompts(dir: string): Prompts {
  const guard = read(dir, 'guard.json');
  const identify = read(dir, 'identify.json');
  const judge = read(dir, 'judge.json');
  return {
    guard: { order: guard.question('order', 'noul'), steer: guard.question('steer', 'noul'), version: guard.version },
    parse: readingPrompt(read(dir, 'parse.json')),
    identify: { film: identify.question('film', 'choice', FILMS), version: identify.version },
    judge: {
      asked: judge.question('asked', 'noul'),
      identity: judge.question('identity', 'noul'),
      missing: judge.question('missing', 'noul'),
      films: judge.films('films'),
      version: judge.version,
    },
  };
}

/** A reader's file, checked. */
function readingPrompt(file: ReturnType<typeof read>): ReadingPrompt {
  const message = object(file.at('message'), file.where('message'));
  const retry = object(file.at('retry'), file.where('retry'));
  const meanings = object(retry.meanings, file.where('retry.meanings'));
  const turn = string(retry.turn, file.where('retry.turn'));
  if (!turn.includes('{findings}')) throw new Error(`${file.where('retry.turn')} must hold {findings}`);
  const schema = object(file.at('schema'), file.where('schema'));
  return {
    instruction: file.string('instruction'),
    schema,
    message: {
      before: string(message.before, file.where('message.before')),
      after: string(message.after, file.where('message.after')),
    },
    retry: {
      turn,
      finding: string(retry.finding, file.where('retry.finding')),
      meanings: Object.fromEntries(
        CHECKS.map((c) => [c, string(meanings[c], file.where(`retry.meanings.${c}`))]),
      ) as Record<Check, string>,
    },
    version: file.version,
  };
}

/** The version of each stage's file, as /healthz reports them. */
export function promptVersions(prompts: Prompts): Record<'guard' | 'parse' | 'identify' | 'judge', string> {
  const { guard, identify, judge, parse } = prompts;
  return { guard: guard.version, parse: parse.version, identify: identify.version, judge: judge.version };
}

/**
 * A stage's version: the first 8 hex digits of the SHA-256 of its file's
 * bytes. A bench run names the versions it tested; two implementations on
 * the same versions ask the same questions.
 */
export function promptVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/** One prompt file, parsed, with what it is read as. */
function read(dir: string, name: string) {
  const path = join(dir, name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new Error(`prompts: cannot read ${path}; set PROMPTS_DIR to the repository's prompts/`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`prompts: ${path} is not JSON`, { cause });
  }
  const content = object(parsed, name);
  const where = (field: string) => `${name}: ${field}`;
  return {
    version: promptVersion(bytes),
    where,
    at: (field: string): unknown => content[field],
    string: (field: string) => string(content[field], where(field)),
    question: (key: string, kind: Question['kind'], options?: readonly string[]): Question => {
      const q = object(content[key], where(key));
      const criteria = object(q.criteria, where(`${key}.criteria`));
      const expected = options ?? ['true', 'false'];
      const keys = Object.keys(criteria);
      if (q.key !== key || q.kind !== kind) throw new Error(`${where(key)} must be the ${kind} question "${key}"`);
      if (keys.length !== expected.length || !expected.every((o) => keys.includes(o))) {
        throw new Error(`${where(`${key}.criteria`)} must describe exactly ${expected.join(', ')}`);
      }
      return {
        key,
        kind,
        instructions: string(q.instructions, where(`${key}.instructions`)),
        criteria: Object.fromEntries(expected.map((o) => [o, string(criteria[o], where(`${key}.criteria.${o}`))])),
      };
    },
    films: (field: string): Record<Film, string> => {
      const names = object(content[field], where(field));
      return Object.fromEntries(FILMS.map((f) => [f, string(names[f], where(`${field}.${f}`))])) as Record<
        Film,
        string
      >;
    },
  };
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} must be a non-empty string`);
  return value;
}
