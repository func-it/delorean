import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Film, Health, Problem, ProblemCode, Quote, Stage } from '../../src/contract.ts';
import { filmsOf } from '../../src/outcome.ts';
import { promptVersions } from '../../src/prompts.ts';
import { CATALOG, discountOf, unitPrice } from './rules.ts';

/**
 * A quoter in fake mode, small enough to read in one sitting: the contract
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
const VERDICTS = ['injection', 'invalid', 'valid'] as const;
const FILMS: readonly Film[] = ['bttf_1', 'bttf_2', 'bttf_3', 'other'];
const VOLUMES: Record<string, Film> = {
  '1': 'bttf_1',
  i: 'bttf_1',
  '2': 'bttf_2',
  ii: 'bttf_2',
  '3': 'bttf_3',
  iii: 'bttf_3',
};

export async function startStubQuoter(options: StubOptions = {}): Promise<Stub> {
  const health: Health = {
    status: 'ok',
    version: 'stub',
    engines: 'fake',
    tracing: false,
    prompts: promptVersions(),
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
      // fatal: an invalid byte is refused, never repaired into U+FFFD
      request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return problem(400, 'malformed_request');
    }
    return isQuoteRequest(request) ? read(request.cart) : problem(400, 'malformed_request');
  }

  /** The pipeline, on fake engines. */
  function read(cart: string): Answer {
    const stages: Quote['usage']['stages'] = [];
    // One call more to a model stage; a stage read again adds up its calls.
    const ran = (stage: Stage, tokens?: number) => {
      const model = stage !== 'prepare' && stage !== 'price';
      const seen = stages.find((s) => s.stage === stage);
      if (seen) {
        seen.calls += 1;
        return;
      }
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
      // and those that draw nothing without being format characters
      .replace(/./gsu, (c) => (drawsNothing(c) ? '' : c))
      .normalize('NFC')
      .trim();
    // A word count stands in for the o200k_base tokenizer.
    const tokens = text.split(/\s+/).filter(Boolean).length;
    const { max_input_tokens: max } = CATALOG.limits;
    ran('prepare', tokens);
    if (text === '') return reject('empty_cart');
    if (tokens > max) return reject('too_long', { tokens: { count: tokens, max } });

    const lines = text.split('\n');
    const steer = INJECTION_MARKERS.some((m) => text.toLowerCase().includes(m)) ? 0.99 : 0.01;
    const order = lines.some((l) => /\p{L}{3,}/u.test(l)) ? 1 : 0;
    const probabilities = { injection: steer, valid: (1 - steer) * order, invalid: (1 - steer) * (1 - order) };
    // The likeliest verdict; a tie goes to the refusal.
    const verdict = VERDICTS.reduce((best, v) => (probabilities[v] > probabilities[best] ? v : best));
    ran('guard');
    if (verdict !== 'valid') {
      const code = verdict === 'injection' ? 'injection' : 'invalid_request';
      const guard = { verdict, confidence: probabilities[verdict], probabilities, questions: { order, steer } };
      return reject(code, { guard });
    }

    if (lines.includes('#fake:engine_down')) {
      // the parse failed, and the recount beside it: what they took is in the usage
      ran('parse');
      ran('recount');
      return problem(502, 'engine_unavailable', { usage: usage() });
    }
    const all = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#fake:')).map((l) => mention(l.trim()));
    // The recount reads everything; #fake:miscount gives it one more copy of the first mention.
    const miscount = lines.includes('#fake:miscount');
    // #fake:recount_offschema: the recount answers off its schema, is asked once more, then left out.
    const offSchema = lines.includes('#fake:recount_offschema');
    const recounted = merge(all.map((m, i) => (miscount && i === 0 ? { ...m, quantity: m.quantity + 1 } : m)));
    const { max_copies_per_title: maxCopies, max_reading_attempts: attempts } = CATALOG.limits;
    const known = new Map<string, Film>();
    const judged = new Map<string, Quote['judge']['checks']>();
    let reading: { title: string; quantity: number; film: Film }[] = [];
    let judge: Quote['judge'] | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // #fake:reread: a first reading leaves out the last mention.
      const parsed = merge(attempt === 1 && lines.includes('#fake:reread') ? all.slice(0, -1) : all);
      ran('parse');
      // The first recount that succeeds is kept for the request; one left out is asked again at the next reading.
      if (offSchema) {
        ran('recount');
        ran('recount');
        const recount = stages.find((s) => s.stage === 'recount');
        if (recount) recount.degraded = true;
      } else if (attempt === 1) {
        ran('recount');
      }
      const tooMany = parsed.find((m) => m.quantity > maxCopies);
      if (tooMany) {
        return reject('quantity_too_large', {
          quantity: { title: tooMany.title, count: tooMany.quantity, max: maxCopies },
        });
      }
      // A first reading with no film is read once more; two readings with none: no_film.
      if (parsed.length === 0 && (attempt === 2 || attempts === 1)) return reject('no_film');
      if (parsed.length === 0) {
        // A later reading with no film fails without being judged.
        const checks = [{ check: 'missing' as const, label: 'the whole reading', score: 0 }];
        judge = { score: 0, threshold: 0.5, checks, attempts: attempt };
        continue;
      }

      // Each title is identified once, whatever the attempt.
      const fresh = [...parsed, ...recounted].filter((m) => !known.has(normalizeTitle(m.title)));
      for (const { title } of fresh) known.set(normalizeTitle(title), identify(title));
      if (fresh.length > 0) ran('identify');
      const filmOf = (title: string) => known.get(normalizeTitle(title)) ?? 'other';
      reading = parsed.map((m) => ({ ...m, film: filmOf(m.title) }));

      // A reading already judged, its lines in any order, is not judged again.
      const key = reading
        .map((l) => JSON.stringify([l.title, l.quantity, l.film]))
        .sort()
        .join();
      let found = judged.get(key);
      if (!found) {
        const named = new Set(reading.map((l) => normalizeTitle(l.title)));
        const lacks = all.some((m) => !named.has(normalizeTitle(m.title)));
        found = [
          ...reading.flatMap(({ title }) => [
            { check: 'asked' as const, label: title, score: 1 },
            { check: 'identity' as const, label: title, score: 1 },
          ]),
          { check: 'missing', label: 'the whole reading', score: lines.includes('#fake:unfaithful') || lacks ? 0 : 1 },
        ];
        judged.set(key, found);
        ran('judge');
      }
      const read = filmsOf(reading);
      const recount = filmsOf(recounted.map((m) => ({ ...m, film: filmOf(m.title) })));
      const checks: Quote['judge']['checks'] = [
        ...found,
        ...FILMS.filter((film) => !offSchema && (film in read || film in recount)).map((film) => {
          const [r, c] = [read[film] ?? 0, recount[film] ?? 0];
          return { check: 'count' as const, label: `${film}: ${r} read, ${c} recounted`, score: r === c ? 1 : 0 };
        }),
      ];
      judge = { score: Math.min(...checks.map((c) => c.score)), threshold: 0.5, checks, attempts: attempt };
      if (judge.score >= judge.threshold) break;
    }
    if (!judge || judge.score < judge.threshold) {
      return reject('unfaithful_reading', judge && { judge: { ...judge, attempts } });
    }

    // No recount succeeded and a line asks for several copies: nothing counted them (quantity_unverified).
    if (offSchema && reading.some((l) => l.quantity > 1)) {
      return problem(503, 'quantity_unverified', {
        detail: 'The quantities could not be cross-checked and a line asks for more than one copy: try again.',
        usage: usage(),
      });
    }

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

/** Mentions of one title, case and spaces aside, add up under its first spelling. */
function merge(mentions: { title: string; quantity: number }[]): { title: string; quantity: number }[] {
  const merged = new Map<string, { title: string; quantity: number }>();
  for (const { title, quantity } of mentions) {
    const seen = merged.get(normalizeTitle(title));
    merged.set(normalizeTitle(title), { title: seen?.title ?? title, quantity: (seen?.quantity ?? 0) + quantity });
  }
  return [...merged.values()];
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

/** Characters that draw nothing without being format characters: the quoter's own table. */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];

function drawsNothing(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return HIDDEN.some(([from, to]) => code >= from && code <= to);
}
