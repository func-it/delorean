import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Film, Health, Problem, ProblemCode, Quote, Stage } from '../../src/contract.ts';
import { CATALOG, discountOf, unitPrice } from './rules.ts';

/**
 * A backend in fake mode, small enough to read in one sitting: the contract
 * and the fake engines of docs/architecture.md, nothing else. The harness
 * tests run the suite and the bench against it.
 */
export interface StubOptions {
  /** Overrides what /healthz says, e.g. live engines to test the RUN_LIVE gate. */
  health?: Partial<Health>;
  /** Alters every quote on its way out, to prove a defect gets caught. */
  tamper?: (quote: Quote) => Quote;
}

export interface Stub {
  url: string;
  /** Every request received, as `METHOD /path`. */
  requests: string[];
  close: () => Promise<void>;
}

interface Answer {
  status: number;
  body: unknown;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ID_HEADERS: Record<string, RegExp> = {
  'x-user-id': /^[A-Za-z0-9._@-]{1,64}$/,
  'x-session-id': /^[A-Za-z0-9._:-]{1,128}$/,
  'x-request-id': REQUEST_ID,
};
const INJECTION_MARKERS = ['ignore', 'disregard', 'oublie', 'instruction', 'system prompt', '<script', 'drop table'];
const PREFIX_QUANTITY = /^([1-9]\d*) [x×] (.+)$/u;
const SUFFIX_QUANTITY = /^(.+) [x×] ([1-9]\d*)$/u;
const SAGA_TITLE = /^back to the future (?:part )?(1|2|3|i|ii|iii)$/;
const VOLUMES: Record<string, Film> = {
  '1': 'bttf_1',
  i: 'bttf_1',
  '2': 'bttf_2',
  ii: 'bttf_2',
  '3': 'bttf_3',
  iii: 'bttf_3',
};

export async function startStubBackend(options: StubOptions = {}): Promise<Stub> {
  const health: Health = {
    status: 'ok',
    implementation: 'typescript',
    version: 'stub',
    engines: 'fake',
    tracing: false,
    ...options.health,
  };
  const tamper = options.tamper ?? ((quote: Quote) => quote);
  const requests: string[] = [];

  const routes: Record<string, { method: string; answer: (req: IncomingMessage) => Answer | Promise<Answer> }> = {
    '/healthz': { method: 'GET', answer: () => ({ status: 200, body: health }) },
    '/v1/catalog': { method: 'GET', answer: () => ({ status: 200, body: CATALOG }) },
    '/v1/quotes': { method: 'POST', answer: postQuote },
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    requests.push(`${req.method ?? ''} ${path}`);
    const route = routes[path];
    const answer = !route
      ? problem(404, 'not_found')
      : route.method !== req.method
        ? problem(405, 'method_not_allowed')
        : route.answer(req);
    void Promise.resolve(answer).then(({ status, body }) => {
      const requestId = req.headers['x-request-id'];
      res.writeHead(status, {
        'content-type': status < 400 ? 'application/json' : 'application/problem+json',
        'x-request-id': typeof requestId === 'string' && REQUEST_ID.test(requestId) ? requestId : randomUUID(),
      });
      res.end(JSON.stringify(body));
    });
  });

  async function postQuote(req: IncomingMessage): Promise<Answer> {
    for (const [name, pattern] of Object.entries(ID_HEADERS)) {
      const value = req.headers[name];
      if (typeof value === 'string' && !pattern.test(value)) return problem(400, 'malformed_request');
    }
    const raw = await readBody(req);
    if (raw.length > CATALOG.limits.max_body_bytes) return problem(413, 'payload_too_large');
    let request: unknown;
    try {
      request = JSON.parse(raw.toString('utf8'));
    } catch {
      return problem(400, 'malformed_request');
    }
    return isQuoteRequest(request) ? read(request.cart) : problem(400, 'malformed_request');
  }

  /** The pipeline, on fake engines. */
  function read(cart: string): Answer {
    const stages: Quote['usage']['stages'] = [];
    const ran = (stage: Stage, tokens?: number) => {
      const model = stage !== 'prepare' && stage !== 'price';
      stages.push({
        stage,
        engine: model ? 'fake' : 'local',
        calls: model ? 1 : 0,
        duration_ms: 0,
        cost_usd: 0,
        ...(tokens !== undefined && { tokens }),
      });
    };
    const usage = (): Quote['usage'] => ({
      implementation: health.implementation,
      engines: health.engines,
      duration_ms: 0,
      cost_usd: 0,
      stages,
    });
    const reject = (code: ProblemCode, facts: Partial<Problem> = {}) =>
      problem(422, code, { ...facts, usage: usage() });

    const text = cart
      .replaceAll('\r\n', '\n')
      .replace(/[^\P{Cc}\n\t]/gu, '')
      // format characters but the zero-width non-joiner and joiner
      .replace(/[^\P{Cf}\u{200C}\u{200D}]/gu, '')
      .normalize('NFC')
      .trim();
    // A word count stands in for the o200k_base tokenizer.
    const tokens = text.split(/\s+/).filter(Boolean).length;
    const { max_input_tokens: max } = CATALOG.limits;
    ran('prepare', tokens);
    if (text === '') return reject('empty_cart');
    if (tokens > max) return reject('too_long', { tokens: { count: tokens, max } });

    const lines = text.split('\n');
    const verdict = INJECTION_MARKERS.some((m) => text.toLowerCase().includes(m))
      ? 'injection'
      : lines.some((l) => /\p{L}{3,}/u.test(l))
        ? 'valid'
        : 'invalid';
    ran('guard');
    if (verdict !== 'valid') {
      const code = verdict === 'injection' ? 'injection' : 'invalid_request';
      return reject(code, { guard: { verdict, confidence: 0.99 } });
    }

    if (lines.includes('#fake:engine_down')) return problem(502, 'engine_unavailable');
    const mentions = new Map<string, { title: string; quantity: number }>();
    for (const line of lines.map((l) => l.trim())) {
      if (line === '' || line.startsWith('#fake:')) continue;
      const { title, quantity } = mention(line);
      const merged = mentions.get(normalizeTitle(title));
      mentions.set(normalizeTitle(title), {
        title: merged?.title ?? title,
        quantity: (merged?.quantity ?? 0) + quantity,
      });
    }
    ran('parse');
    if (mentions.size === 0) return reject('no_film');
    const { max_copies_per_title: maxCopies } = CATALOG.limits;
    const tooMany = [...mentions.values()].find((m) => m.quantity > maxCopies);
    if (tooMany) {
      return reject('quantity_too_large', {
        quantity: { title: tooMany.title, count: tooMany.quantity, max: maxCopies },
      });
    }

    const reading = [...mentions.values()].map((m) => ({ ...m, film: identify(m.title) }));
    ran('identify');

    const checks: Quote['judge']['checks'] = [
      ...reading.flatMap(({ title }) => [
        { check: 'asked' as const, label: title, score: 1 },
        { check: 'identity' as const, label: title, score: 1 },
        { check: 'quantity' as const, label: title, score: 1 },
      ]),
      { check: 'missing', label: 'the reading', score: lines.includes('#fake:unfaithful') ? 0 : 1 },
    ];
    const judge = { score: Math.min(...checks.map((c) => c.score)), threshold: 0.5, checks };
    ran('judge');
    if (judge.score < judge.threshold) return reject('unfaithful_reading', { judge });

    ran('price');
    const priced = reading.map((l) => ({
      ...l,
      confidence: 1,
      unit_price_cents: unitPrice(l.film),
      subtotal_cents: unitPrice(l.film) * l.quantity,
    }));
    const subtotal = priced.reduce((total, l) => total + l.subtotal_cents, 0);
    const discount = discountOf(priced);
    const quote: Quote = {
      id: `q_${randomUUID().slice(0, 8)}`,
      currency: 'EUR',
      lines: priced,
      subtotal_cents: subtotal,
      discount,
      total_cents: subtotal - discount.amount_cents,
      judge,
      usage: usage(),
      created_at: new Date().toISOString(),
    };
    return { status: 200, body: tamper(quote) };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

/** `N x title`, `title x N` (or ×), else one copy. */
function mention(line: string): { title: string; quantity: number } {
  const prefix = PREFIX_QUANTITY.exec(line);
  if (prefix) return { title: prefix[2]?.trim() ?? '', quantity: Number(prefix[1]) };
  const suffix = SUFFIX_QUANTITY.exec(line);
  if (suffix) return { title: suffix[1]?.trim() ?? '', quantity: Number(suffix[2]) };
  return { title: line, quantity: 1 };
}

function identify(title: string): Film {
  const volume = SAGA_TITLE.exec(normalizeTitle(title))?.[1] ?? '';
  return VOLUMES[volume] ?? 'other';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function problem(status: number, code: ProblemCode, facts: Partial<Problem> = {}): Answer {
  const body: Problem = { type: `/problems/${code}`, title: code.replaceAll('_', ' '), status, code, ...facts };
  return { status, body };
}

function isQuoteRequest(value: unknown): value is { cart: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).join() === 'cart' &&
    typeof (value as { cart: unknown }).cart === 'string'
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
