import { randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono, type Context as HonoContext } from 'hono';
import { MAX_QUANTITY, volumeOf } from '../cart.ts';
import type { Logger } from '../log.ts';
import { reportOf, type Pipeline, type QuoteRequest } from '../pipeline/pipeline.ts';
import { EngineError } from '../pipeline/ports.ts';
import { Rejection, type Report } from '../pipeline/rejection.ts';
import type { Tracing } from '../telemetry/langfuse.ts';
import { observe, withTraceAttributes } from '../telemetry/trace.ts';
import { Malformed, TooLarge, decodeQuoteRequest, readBody } from './body.ts';
import * as contract from './contract.ts';

/**
 * The HTTP surface of api/openapi.yaml: the health, the catalog and the
 * quotes. It decodes, validates, runs the pipeline and answers, every error
 * as an RFC 9457 problem with a stable code. Every answer carries its
 * X-Request-Id.
 */
export interface AppConfig {
  pipeline: Pipeline;
  /** The build's version, as /healthz reports it. */
  version: string;
  /** The version of each prompt file the service runs, as /healthz reports them. */
  prompts: contract.Health['prompts'];
  /** Whether traces are exported to Langfuse, and how a trace is scored. */
  tracing: Pick<Tracing, 'enabled' | 'score'>;
  maxBodyBytes: number;
  /** The budget of a quote, model calls included. */
  requestTimeoutMs: number;
  log: Logger;
}

/** What the middleware and the handlers share about one request: its id, and how it ended, for the log line. */
interface Exchange {
  id: string;
  /** The problem answered, if any. */
  code?: contract.ProblemCode;
  /** What went wrong behind a 5xx: logged, never shown. */
  cause?: unknown;
  /** A stage failed and the quote went on without it, or was refused without it (the recount). */
  degraded?: boolean;
}

/** The node server's bindings, absent when the app is called in-process (tests). */
type Env = { Variables: { exchange: Exchange }; Bindings: Partial<HttpBindings> };

/** How a quote was answered, for its trace: the response, its body, the outcome and what the reading took. */
interface Answered {
  response: Response;
  body: unknown;
  /** `priced`, or the problem's code. */
  outcome: string;
  report: Report | undefined;
  quoteId?: string;
  totalCents?: number;
  /** What failed behind a 502 or a 500: logged, and the trace marked failed. */
  cause?: unknown;
}

/** The formats of the contract's headers, length included. */
const HEADER_FORMATS = {
  'X-User-Id': /^[A-Za-z0-9._@-]{1,64}$/,
  'X-Session-Id': /^[A-Za-z0-9._:-]{1,128}$/,
  'X-Request-Id': /^[A-Za-z0-9._:-]{1,128}$/,
} as const;

/** The routes, and the methods each answers; HEAD comes with GET. */
const ROUTES: Record<string, string> = { '/healthz': 'GET, HEAD', '/v1/catalog': 'GET, HEAD', '/v1/quotes': 'POST' };

export function createApp(config: AppConfig): Hono<Env> {
  const { pipeline, log } = config;
  const context: contract.Context = {
    engines: pipeline.config.engines.name,
    judgeThreshold: pipeline.config.judgeThreshold,
  };
  const app = new Hono<Env>();

  // the client's X-Request-Id when it has the contract's format, a new one otherwise
  app.use(async (c, next) => {
    const sent = c.req.header('X-Request-Id');
    const id = sent !== undefined && HEADER_FORMATS['X-Request-Id'].test(sent) ? sent : newRequestId();
    c.set('exchange', { id });
    c.header('X-Request-Id', id);
    await next();
  });

  // one log line per request, once answered
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const { id, code, cause, degraded } = c.var.exchange;
    const status = c.res.status;
    // the body's length, read off a copy: the answer itself goes out untouched; a HEAD says the length its GET has
    const bytes = (await c.res.clone().arrayBuffer()).byteLength;
    c.res.headers.set('Content-Length', String(bytes));
    log.log(status >= 500 ? 'ERROR' : 'INFO', 'request', {
      request_id: id,
      method: c.req.method,
      path: c.req.path,
      status,
      ms: Math.round(performance.now() - started),
      bytes,
      ...(code && { code }),
      ...(cause !== undefined && { err: describe(cause) }),
      ...(degraded && { degraded: 'recount' }),
    });
  });

  app.get('/healthz', (c) =>
    c.json<contract.Health>({
      status: 'ok',
      implementation: 'typescript',
      version: config.version,
      engines: context.engines,
      tracing: config.tracing.enabled,
      prompts: config.prompts,
    }),
  );

  app.get('/v1/catalog', (c) => {
    const { catalog, maxInputTokens } = pipeline.config;
    return c.json<contract.Catalog>({
      currency: 'EUR',
      films: catalog.volumes.map((v) => ({
        id: v.film,
        title: v.title,
        volume: volumeOf(v.film),
        unit_price_cents: v.unitCents,
      })),
      other_film_unit_price_cents: catalog.otherUnitCents,
      saga_discounts: catalog.tiers.map((t) => ({ distinct_volumes: t.distinctVolumes, percent: t.percent })),
      limits: {
        max_reading_attempts: pipeline.config.readAttempts,
        max_body_bytes: config.maxBodyBytes,
        max_input_tokens: maxInputTokens,
        max_copies_per_title: MAX_QUANTITY,
      },
    });
  });

  app.post('/v1/quotes', async (c) => {
    for (const [name, format] of Object.entries(HEADER_FORMATS)) {
      const given = timesGiven(c, name);
      if (given > 1) {
        return answer(
          c,
          contract.problem(400, 'malformed_request', `header ${name}: expected one value, got ${given}`),
        );
      }
      const value = c.req.header(name);
      if (value !== undefined && !format.test(value)) {
        return answer(c, contract.problem(400, 'malformed_request', `header ${name}: must match ${format.source}`));
      }
    }
    let cart: string;
    try {
      cart = decodeQuoteRequest(await readBody(c.req.raw, config.maxBodyBytes));
    } catch (error) {
      if (error instanceof TooLarge) return answer(c, contract.problem(413, 'payload_too_large', error.message));
      if (error instanceof Malformed) return answer(c, contract.problem(400, 'malformed_request', error.message));
      throw error;
    }

    // the request's budget, or the client gone: either ends the model calls
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(config.requestTimeoutMs)]);
    const userId = c.req.header('X-User-Id');
    const sessionId = c.req.header('X-Session-Id');
    const request = { cart, ...(userId !== undefined && { userId }), ...(sessionId !== undefined && { sessionId }) };
    return traced(c, request, (traceId) =>
      quote(c, request, signal, { ...context, ...(traceId !== undefined && { traceId }) }),
    );
  });

  /** Runs the pipeline and answers with what it read: the quote, the refusal, or the engine's failure. */
  async function quote(c: HonoContext<Env>, request: QuoteRequest, signal: AbortSignal, context: contract.Context) {
    try {
      const q = await pipeline.quote(request, signal);
      c.var.exchange.degraded = wasDegraded(q.report);
      const body = contract.quote(q, context);
      return {
        response: c.json(body),
        body,
        outcome: 'priced',
        report: q.report,
        quoteId: q.id,
        totalCents: q.price.totalCents,
      };
    } catch (error) {
      if (error instanceof Rejection) {
        c.var.exchange.degraded = wasDegraded(error.report);
        return refused(c, contract.rejected(error, context), error.code, error.report);
      }
      if (error instanceof EngineError) {
        const detail = 'A model engine could not be reached, or answered out of contract.';
        return refused(
          c,
          contract.problem(502, 'engine_unavailable', detail),
          'engine_unavailable',
          error.report,
          error,
        );
      }
      return refused(c, internalProblem(), 'internal', reportOf(error), error);
    }
  }

  /**
   * Runs one quote in its trace (docs/architecture.md, "Usage, cost and
   * traces"): the agent `quote`, with who asks, its tags and metadata, the
   * cart as prepared for input and the answer for output; then its measures
   * as scores, every quote its cost, latency and outcome, a bug's included.
   */
  function traced(c: HonoContext<Env>, request: QuoteRequest, run: (traceId: string | undefined) => Promise<Answered>) {
    const started = performance.now();
    // on every observation of the trace, as the Langfuse SDKs write them
    const who = {
      traceName: 'quote',
      tags: ['quoter:typescript', `engines:${context.engines}`],
      ...(request.userId !== undefined && { userId: request.userId }),
      ...(request.sessionId !== undefined && { sessionId: request.sessionId }),
    };
    return observe('quote', 'agent', (trace) =>
      withTraceAttributes(who, async () => {
        trace.traceAttributes({ metadata: { request_id: c.var.exchange.id, prompts: config.prompts } });
        // the cart as received, from the start: a trace says what came in even if nothing is read
        trace.traceIO({ input: request.cart });
        const answered = await run(trace.traceId);
        const { body, outcome, report, quoteId, totalCents, cause } = answered;
        // a client that went away cancelled its quote: no failure of ours
        if (cause !== undefined && !c.req.raw.signal.aborted) trace.fail(cause);
        trace.traceIO({ output: body });
        const attempts = report?.attempts;
        const degraded = wasDegraded(report);
        trace.traceAttributes({
          metadata: {
            outcome,
            ...(attempts !== undefined && { attempts }),
            ...(degraded && { degraded: 'recount' }),
            ...(quoteId !== undefined && { quote_id: quoteId }),
            ...(totalCents !== undefined && { total_cents: totalCents }),
          },
        });
        if (trace.traceId !== undefined) {
          config.tracing.score(trace.traceId, [
            { name: 'cost_usd', value: report?.costUsd ?? 0 },
            { name: 'latency_ms', value: report?.ms ?? Math.round(performance.now() - started) },
            ...(attempts !== undefined ? [{ name: 'attempts', value: attempts }] : []),
            { name: 'outcome', value: outcome },
          ]);
        }
        return answered.response;
      }),
    );
  }

  // a known path under another method: 405, with the methods it takes
  for (const [path, allow] of Object.entries(ROUTES)) {
    app.all(path, (c) => {
      c.header('Allow', allow);
      const detail = `${path} answers ${allow}, not ${c.req.method}.`;
      return answer(c, contract.problem(405, 'method_not_allowed', detail));
    });
  }

  app.notFound((c) => answer(c, contract.problem(404, 'not_found', `Nothing at ${c.req.path}.`)));

  app.onError((error, c) => answer(c, internalProblem(), error));

  return app;
}

/** Answers with a problem. `cause` is what went wrong behind it: logged, never shown. */
function answer(c: HonoContext<Env>, problem: contract.Problem, cause?: unknown): Response {
  return refused(c, problem, problem.code, undefined, cause).response;
}

/** Whether a stage of the report failed and the answer was made without it. */
function wasDegraded(report: Report | undefined): boolean {
  return report?.stages.some((s) => s.degraded === true) === true;
}

/** Answers a quote with a problem, and says how, for its trace: the body as sent, request id included. */
function refused(
  c: HonoContext<Env>,
  problem: contract.Problem,
  outcome: string,
  report: Report | undefined,
  cause?: unknown,
): Answered {
  const exchange = c.var.exchange;
  exchange.code = problem.code;
  if (cause !== undefined) exchange.cause = cause;
  // the contract's order: the request id after the detail, then the facts
  const { type, title, status, code, detail, guard, judge, tokens, quantity, usage } = problem;
  const body: contract.Problem = {
    type,
    title,
    status,
    code,
    ...(detail !== undefined && { detail }),
    request_id: exchange.id,
    ...(guard && { guard }),
    ...(judge && { judge }),
    ...(tokens && { tokens }),
    ...(quantity && { quantity }),
    ...(usage && { usage }),
  };
  const response = c.body(JSON.stringify(body), problem.status as 400, { 'Content-Type': 'application/problem+json' });
  return { response, body, outcome, report, ...(cause !== undefined && { cause }) };
}

function internalProblem(): contract.Problem {
  return contract.problem(500, 'internal', 'Something went wrong on our side; the request id tells us where.');
}

/**
 * How many times a request gives a header: the fetch API joins repeated
 * values with ", ", so the count comes from the node server's raw headers.
 */
function timesGiven(c: HonoContext<Env>, name: string): number {
  // no env when the app is called in-process
  const raw = (c.env as Env['Bindings'] | undefined)?.incoming?.rawHeaders;
  if (!raw) return c.req.header(name) === undefined ? 0 : 1;
  const lower = name.toLowerCase();
  return raw.filter((h, i) => i % 2 === 0 && h.toLowerCase() === lower).length;
}

/** 26 base32 characters ([A-Z2-7]) of 128 random bits, as every quoter makes a request id. */
export function newRequestId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0n;
  for (const byte of randomBytes(16)) bits = (bits << 8n) | BigInt(byte);
  // 128 bits make 25 full characters and a last one of 3 bits, padded with zeros as RFC 4648 writes it
  bits <<= 2n;
  return Array.from({ length: 26 }, (_, i) => alphabet[Number((bits >> BigInt(5 * (25 - i))) & 31n)]).join('');
}

/** An error and its causes, on one line; a cause its error already quotes is said once. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.cause === undefined) return error.message;
  const cause = describe(error.cause);
  return error.message.endsWith(cause) ? error.message : `${error.message}: ${cause}`;
}
