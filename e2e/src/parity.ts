import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CONTRACT_PATH } from './contract.ts';
import { loadQuoteCases } from './cases.ts';

/**
 * The parity suite holds the three quoters to the same bytes (docs/
 * architecture.md, Identical quoters): one request, sent to each, must come
 * back with the same status, headers and body, and leave the same log line,
 * once what is random or timed in them is replaced by a placeholder.
 */

export const QUOTERS = ['go', 'typescript', 'python'] as const;
export type Quoter = (typeof QUOTERS)[number];

export interface Probe {
  name: string;
  method: string;
  path: string;
  /** A header given an array is sent once per value. */
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  /** Sent without X-Request-Id: the quoter makes one up. */
  anonymous?: boolean;
}

export interface Answer {
  status: number;
  /** Lower-cased names, values as received. */
  headers: Record<string, string>;
  body: string;
}

/** The headers a client sees; transport headers (Date, Connection, Keep-Alive) are the server's. */
export const COMPARED_HEADERS = ['content-type', 'allow', 'x-request-id', 'content-length'] as const;

const QUOTES = '/v1/quotes';
const JSON_TYPE = { 'Content-Type': 'application/json' };

/** Every probe of the suite: the API's edges, then every shared quote case. */
export function probes(): Probe[] {
  const quote = (name: string, body: string | Buffer, headers: Record<string, string | string[]> = {}): Probe => ({
    name,
    method: 'POST',
    path: QUOTES,
    headers: { ...JSON_TYPE, ...headers },
    body,
  });
  const cart = (text: string): string => JSON.stringify({ cart: text });
  const edges: Probe[] = [
    { name: 'healthz', method: 'GET', path: '/healthz', anonymous: true },
    { name: 'healthz, named', method: 'GET', path: '/healthz' },
    { name: 'catalog', method: 'GET', path: '/v1/catalog' },
    { name: 'catalog, HEAD', method: 'HEAD', path: '/v1/catalog' },
    { name: 'catalog, a query string', method: 'GET', path: '/v1/catalog?x=1' },
    { name: 'catalog, a trailing slash', method: 'GET', path: '/v1/catalog/' },
    { name: 'unknown path', method: 'GET', path: '/v1/films' },
    { name: 'root', method: 'GET', path: '/' },
    { name: 'quotes, GET', method: 'GET', path: QUOTES },
    { name: 'quotes, OPTIONS', method: 'OPTIONS', path: QUOTES },
    { name: 'catalog, POST', method: 'POST', path: '/v1/catalog', body: '{}' },
    { ...quote('priced, anonymous', cart('Back to the Future 1\nBack to the Future 2\nHeat')), anonymous: true },
    { ...quote('malformed, anonymous', '{'), anonymous: true },
    { ...quote('engine down, anonymous', cart('Back to the Future 1 #fake:engine_down')), anonymous: true },
    quote('priced', cart('Back to the Future 1\nBack to the Future 2\nHeat')),
    quote('priced, user and session', cart('Back to the Future 3'), {
      'X-User-Id': 'marty@hill.valley',
      'X-Session-Id': 'session:1985',
    }),
    quote('no Content-Type', cart('Heat'), { 'Content-Type': [] }),
    quote('Content-Type text/plain', cart('Heat'), { 'Content-Type': 'text/plain' }),
    quote('empty body', ''),
    quote('whitespace body', '  \n'),
    quote('truncated JSON', '{"cart":"Heat"'),
    quote('invalid JSON', '{cart:"Heat"}'),
    quote('data after the object', '{"cart":"Heat"} {}'),
    quote('JSON array', '["Heat"]'),
    quote('JSON string', '"Heat"'),
    quote('JSON number', '42'),
    quote('JSON null', 'null'),
    quote('no cart', '{}'),
    quote('cart null', '{"cart":null}'),
    quote('cart a number', '{"cart":1985}'),
    quote('cart a boolean', '{"cart":true}'),
    quote('cart an array', '{"cart":["Heat"]}'),
    quote('cart an object', '{"cart":{"title":"Heat"}}'),
    quote('unknown field', '{"cart":"Heat","x":1}'),
    quote('cart twice', '{"cart":"Heat","cart":"Alien"}'),
    quote(
      'invalid UTF-8',
      Buffer.concat([Buffer.from('{"cart":"Back '), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
    ),
    quote('escaped unicode', '{"cart":"La ch\\u00e8vre\\nBack to the Future 2"}'),
    quote('lone surrogate', '{"cart":"\\ud800 Heat"}'),
    quote(
      'HTML characters, line separators, a control character',
      cart('Back to the Future <1> & 2\u2028Heat\u2029\u0001'),
    ),
    quote('a backslash before u2028', cart('Heat \\u2028')),
    quote('too large', cart('x'.repeat(70_000))),
    quote('bad X-Request-Id', cart('Heat'), { 'X-Request-Id': 'not valid!' }),
    quote('long X-Request-Id', cart('Heat'), { 'X-Request-Id': 'r'.repeat(129) }),
    quote('bad X-User-Id', cart('Heat'), { 'X-User-Id': 'marty mcfly' }),
    quote('bad X-Session-Id', cart('Heat'), { 'X-Session-Id': 'a b' }),
    quote('X-User-Id twice', cart('Heat'), { 'X-User-Id': ['marty', 'doc'] }),
    quote('X-Session-Id twice', cart('Heat'), { 'X-Session-Id': ['a', 'b'] }),
    quote('empty cart', cart('')),
    quote('blank cart', cart(' \n\t ')),
    quote('too long', cart('Back to the Future '.repeat(600))),
    quote('one word, 60 KB', cart('a'.repeat(60_000))),
    quote('engine down', cart('Back to the Future 1 #fake:engine_down')),
    quote('unfaithful', cart('Back to the Future 1 #fake:unfaithful')),
    quote('miscount', cart('Back to the Future 1 #fake:miscount')),
    quote('read again', cart('Back to the Future 2 #fake:reread')),
  ];
  const cases = loadQuoteCases().map((c) => quote(`case ${c.id}`, JSON.stringify(c.input)));
  // The others carry a request id of their own, which names them in the logs.
  return [...edges, ...cases].map((p, i) =>
    p.anonymous === true || p.headers?.['X-Request-Id'] !== undefined
      ? p
      : { ...p, headers: { ...p.headers, 'X-Request-Id': `parity-${String(i).padStart(3, '0')}` } },
  );
}

/** Sends `probe` as is: repeated headers, raw bytes, no client of its own opinion. */
export function send(baseUrl: string, probe: Probe): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(probe.path, baseUrl), { method: probe.method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    for (const [name, value] of Object.entries(probe.headers ?? {})) {
      // An empty array sends no such header.
      if (!Array.isArray(value) || value.length > 0) req.setHeader(name, value);
    }
    req.end(probe.body);
  });
}

/** Placeholders, each for one value that differs by nature from one answer to another. */
export const PLACEHOLDER = {
  requestId: '<request-id>',
  quoteId: '<quote-id>',
  time: '<time>',
  ms: '<ms>',
  bytes: '<bytes>',
  quoter: '<quoter>',
  addr: '<addr>',
  traceId: '<trace-id>',
} as const;

/** A generated request id: 26 base32 characters, 128 random bits. */
export const GENERATED_REQUEST_ID = /^[A-Z2-7]{26}$/;
/** A time, UTC with milliseconds. */
export const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const QUOTE_ID = /"id":"q_[a-z2-7]{16}"/g;
const CREATED_AT = /"created_at":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/g;
const DURATION = /"duration_ms":\d+/g;
const TRACE_ID = /"trace_id":"[0-9a-f]{32}"/g;

/** A body, or a trace's copy of it, with its quote id, times, durations, trace id and quoter replaced. */
export function normalizeBody(body: string, quoter: Quoter): string {
  return body
    .replace(QUOTE_ID, `"id":"${PLACEHOLDER.quoteId}"`)
    .replace(CREATED_AT, `"created_at":"${PLACEHOLDER.time}"`)
    .replace(DURATION, `"duration_ms":"${PLACEHOLDER.ms}"`)
    .replace(TRACE_ID, `"trace_id":"${PLACEHOLDER.traceId}"`)
    .replaceAll(`"implementation":"${quoter}"`, `"implementation":"${PLACEHOLDER.quoter}"`);
}

/**
 * What must match across quoters, from one answer of `quoter`: the compared
 * headers, the body with its random and timed values replaced. A value off
 * its format (a microsecond time, a UUID) is left as is, so the comparison
 * shows it.
 */
export function normalizeAnswer(answer: Answer, quoter: Quoter, sent: Probe): Answer {
  const rid = answer.headers['x-request-id'];
  let body = normalizeBody(answer.body, quoter);
  const headers: Record<string, string> = {};
  for (const name of COMPARED_HEADERS) {
    const value = answer.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (rid !== undefined && rid !== sent.headers?.['X-Request-Id'] && GENERATED_REQUEST_ID.test(rid)) {
    body = body.replaceAll(`"request_id":"${rid}"`, `"request_id":"${PLACEHOLDER.requestId}"`);
    headers['x-request-id'] = PLACEHOLDER.requestId;
  }
  // The length follows the durations' digits: it must be the body's own, not another quoter's.
  if (headers['content-length'] !== undefined) {
    headers['content-length'] =
      Number(headers['content-length']) === Buffer.byteLength(answer.body)
        ? PLACEHOLDER.bytes
        : headers['content-length'];
  }
  return { status: answer.status, headers, body };
}

export type LogLine = Record<string, unknown>;

/**
 * Reads a quoter's log: one compact JSON object per line. A line that is not
 * JSON, or not compact, comes back as `{raw}` so that the comparison shows it.
 */
export function readLog(text: string): LogLine[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return { raw: line };
        return JSON.stringify(value) === line ? (value as LogLine) : { raw: line };
      } catch {
        return { raw: line };
      }
    });
}

/**
 * A log line with its timed values replaced: `time` when UTC with
 * milliseconds, `ms`, `bytes`, the generated request id and the listening
 * address. Key order is kept: it is compared too.
 */
export function normalizeLogLine(line: LogLine, generatedIds: ReadonlySet<string> = new Set()): string {
  const out: LogLine = {};
  for (const [key, value] of Object.entries(line)) {
    if (key === 'time' && typeof value === 'string' && TIME.test(value)) out[key] = PLACEHOLDER.time;
    else if (key === 'ms' && typeof value === 'number' && Number.isInteger(value) && value >= 0)
      out[key] = PLACEHOLDER.ms;
    else if (key === 'bytes' && typeof value === 'number' && Number.isInteger(value)) out[key] = PLACEHOLDER.bytes;
    else if (key === 'request_id' && typeof value === 'string' && generatedIds.has(value))
      out[key] = PLACEHOLDER.requestId;
    else if (key === 'addr' && typeof value === 'string' && /^:\d+$/.test(value)) out[key] = PLACEHOLDER.addr;
    else out[key] = value;
  }
  return JSON.stringify(out);
}

interface SchemaNode {
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
}

const schemas = (parse(readFileSync(CONTRACT_PATH, 'utf8')) as { components: { schemas: Record<string, SchemaNode> } })
  .components.schemas;

function resolve(node: SchemaNode): SchemaNode {
  let n = node;
  while (n.$ref !== undefined) {
    const name = n.$ref.split('/').at(-1) ?? '';
    const next = schemas[name];
    if (next === undefined) throw new Error(`no schema ${name} in the contract`);
    n = next;
  }
  return n;
}

/**
 * The places where `value` lists its keys in another order than the
 * contract's schema `name` declares them; a map's keys must be sorted.
 * Empty when the order is the contract's.
 */
export function keyOrderViolations(name: string, value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, node: SchemaNode, path: string): void => {
    const s = resolve(node);
    if (Array.isArray(v)) {
      if (s.items) {
        const items = s.items;
        v.forEach((x, i) => {
          walk(x, items, `${path}[${i}]`);
        });
      }
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const keys = Object.keys(v);
    if (s.properties) {
      const declared = Object.keys(s.properties);
      const known = keys.filter((k) => declared.includes(k));
      const expected = [...known].sort((a, b) => declared.indexOf(a) - declared.indexOf(b));
      if (known.join() !== expected.join())
        out.push(`${path}: ${known.join(', ')}; the contract: ${expected.join(', ')}`);
      for (const k of known) walk((v as Record<string, unknown>)[k], s.properties[k] as SchemaNode, `${path}.${k}`);
    } else if (typeof s.additionalProperties === 'object') {
      const sorted = [...keys].sort();
      if (keys.join() !== sorted.join()) out.push(`${path}: ${keys.join(', ')}; sorted: ${sorted.join(', ')}`);
      for (const k of keys) walk((v as Record<string, unknown>)[k], s.additionalProperties, `${path}.${k}`);
    }
  };
  walk(value, { $ref: `#/components/schemas/${name}` }, name);
  return out;
}

/**
 * Whether `body` is written as the rules say: compact JSON, numbers as
 * ECMAScript writes them, no trailing newline. Returns what differs, or
 * undefined.
 */
export function formatViolation(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'not JSON';
  }
  const canonical = JSON.stringify(value);
  if (canonical === body) return undefined;
  let i = 0;
  while (i < body.length && body[i] === canonical[i]) i++;
  return `not canonical JSON from character ${i}: …${body.slice(Math.max(0, i - 20), i + 20)}…`;
}

export type PerQuoter<T> = Record<Quoter, T>;

/** Reads a JSON object with one entry per quoter from `name` in `env`. */
export function perQuoter<T>(env: NodeJS.ProcessEnv, name: string): PerQuoter<T> {
  const raw = env[name];
  if (raw === undefined) throw new Error(`${name} is not set: run task e2e:parity (scripts/e2e-parity.sh)`);
  const value = JSON.parse(raw) as Partial<PerQuoter<T>>;
  for (const q of QUOTERS) {
    if (value[q] === undefined) throw new Error(`${name} has no entry for ${q}`);
  }
  return value as PerQuoter<T>;
}

/** The contract schema an answer to `probe` follows, or undefined when its body is not JSON. */
export function schemaOf(probe: Probe, answer: Answer): string | undefined {
  if (answer.body === '') return undefined;
  if (answer.status >= 400) return 'Problem';
  if (probe.path.startsWith('/healthz')) return 'Health';
  if (probe.path.startsWith('/v1/catalog')) return 'Catalog';
  return 'Quote';
}

/** The environment of a quoter started by the suite: no key, no Langfuse, no setting of the caller's. */
export function cleanEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const kept = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'UV_CACHE_DIR', 'TIKTOKEN_CACHE_DIR', 'NODE_OPTIONS'];
  for (const k of kept) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return { ...out, ...extra };
}

/** The fake engines' time per stage with FAKE_LATENCY=real (docs/architecture.md, Fake latency). */
export const FAKE_PROFILE_MS = { guard: 400, parse: 1200, recount: 2500, identify: 300, judge: 350 } as const;

/** How long the fake call of `stage` reading `input` takes: its base ± 20 %, by SHA-256. */
export function fakeDelayMs(stage: keyof typeof FAKE_PROFILE_MS, input: string): number {
  const base = BigInt(FAKE_PROFILE_MS[stage]);
  const n = BigInt(createHash('sha256').update(`${stage}\n${input}`).digest().readUInt32BE(0));
  return Number((base * 4n) / 5n + (base * 2n * n) / (5n << 32n));
}
