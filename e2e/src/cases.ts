import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ajv, schemaRef, type Film, type Health, type ProblemCode } from './contract.ts';

export const CASES_DIR = fileURLToPath(new URL('../../cases/quote', import.meta.url));

export type FilmCounts = Partial<Record<Film, number>>;

export interface PricedExpectation {
  status: 200;
  total_cents: number;
  /** Total quantity per film; `other` adds up every film outside the saga. */
  films?: FilmCounts;
}

export interface RejectedExpectation {
  status: number;
  code: ProblemCode;
}

export interface QuoteCase {
  id: string;
  /** Why the case exists: the mistake it guards against. */
  note: string;
  tags: string[];
  input: { cart: string };
  expect: PricedExpectation | RejectedExpectation;
}

/** The shape of a case file, in the contract's own vocabulary. */
const validateCase = ajv.compile<QuoteCase>({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'note', 'tags', 'input', 'expect'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    note: { type: 'string', minLength: 1 },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    input: { $ref: schemaRef('QuoteRequest') },
    expect: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'total_cents'],
          properties: {
            status: { const: 200 },
            total_cents: { type: 'integer', minimum: 0 },
            films: {
              type: 'object',
              propertyNames: { $ref: schemaRef('Film') },
              additionalProperties: { type: 'integer', minimum: 1 },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'code'],
          properties: {
            status: { type: 'integer', minimum: 400, maximum: 599 },
            code: { $ref: schemaRef('ProblemCode') },
          },
        },
      ],
    },
  },
});

/** Reads every case of `dir`, sorted by id; a malformed case file throws. */
export function loadQuoteCases(dir: string = CASES_DIR): QuoteCase[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!validateCase(data)) {
        throw new Error(`${path}: ${ajv.errorsText(validateCase.errors)}`);
      }
      if (data.id !== basename(file, '.json')) {
        throw new Error(`${path}: id "${data.id}" differs from the file name`);
      }
      return data;
    });
}

/**
 * Fake engines only pass the cases tagged `fake`; live engines play them all.
 * `tag` narrows the selection further.
 */
export function selectCases(cases: QuoteCase[], engines: Health['engines'], tag?: string): QuoteCase[] {
  return cases.filter(
    (c) => (engines === 'live' || c.tags.includes('fake')) && (tag === undefined || c.tags.includes(tag)),
  );
}
