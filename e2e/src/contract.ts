import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';
import type { components } from './generated/openapi.ts';

type Schemas = components['schemas'];
export type Quote = Schemas['Quote'];
export type Problem = Schemas['Problem'];
export type ProblemCode = Schemas['ProblemCode'];
export type Health = Schemas['Health'];
export type Catalog = Schemas['Catalog'];
export type Usage = Schemas['Usage'];
export type Film = Schemas['Film'];
export type Stage = Schemas['StageUsage']['stage'];

export const CONTRACT_PATH = new URL('../../api/openapi.yaml', import.meta.url);

/** The stages of POST /v1/quotes, in pipeline order. */
export const STAGES: readonly Stage[] = ['prepare', 'guard', 'parse', 'recount', 'identify', 'judge', 'price'];

/** The stage that answers each 422 code. */
export const REJECTED_BY: Partial<Record<ProblemCode, Stage>> = {
  empty_cart: 'prepare',
  too_long: 'prepare',
  injection: 'guard',
  invalid_request: 'guard',
  no_film: 'parse',
  quantity_too_large: 'parse',
  demo_unreadable: 'parse',
  unfaithful_reading: 'judge',
  // refused once the judge held the reading, before the price
  repeated_titles: 'judge',
};

// ajv-formats ships CommonJS whose default export TypeScript sees under `.default`.
const addFormats = addFormatsModule.default;

const document = parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
  components: { schemas: Record<string, unknown> };
};

/**
 * OpenAPI 3.1 schemas are JSON Schema 2020-12. The component schemas are
 * registered under the contract's own path so that their `$ref`s
 * (`#/components/schemas/…`) resolve as written in the YAML.
 */
export const ajv = new Ajv2020({ allErrors: true, strict: true, keywords: ['components'] });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi.yaml', components: { schemas: document.components.schemas } });

export function schemaRef(name: keyof Schemas): string {
  return `openapi.yaml#/components/schemas/${name}`;
}

/** Ways `body` breaks the contract's schema `name`; empty when it conforms. */
export function contractViolations(name: keyof Schemas, body: unknown): string[] {
  const validate = ajv.getSchema(schemaRef(name));
  if (!validate) throw new Error(`no schema ${name} in the contract`);
  return validate(body) ? [] : (validate.errors ?? []).map(describe);
}

function describe(error: ErrorObject): string {
  return `${error.instancePath || '/'} ${error.message ?? error.keyword} ${JSON.stringify(error.params)}`;
}

/** The media type of a response, without parameters such as charset. */
export function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
