import { EngineError, isCancelled } from '../../pipeline/ports.ts';
import type { Question } from '../../prompts.ts';
import { observe } from '../../telemetry/trace.ts';

/**
 * Jev (TypeSafe), a System One model: it answers typed questions about a
 * state with calibrated probabilities, never prose. It lives on OpenRouter's
 * decisions endpoint, not on chat/completions: POST {model, state,
 * questions}, answered with {id, answers, usage}.
 *
 * Questions put in one request are answered together, and colour one
 * another: independent judgements go in requests of their own (decideAll).
 */

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_MODEL = 'typesafe/jev-1.13';

/** One call: every key of `state` is a document Jev reads, named for what it is. */
export interface Request {
  state: Record<string, string>;
  questions: readonly Question[];
}

/** One question's answer: `noul` for a noul question, `choice` and `probabilities` for a choice. */
export interface Answer {
  noul: number;
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

/** Every answer of one request, and what it took. */
export interface Decision {
  answers: Record<string, Answer>;
  /** USD, as OpenRouter bills it; 0 when it says nothing. */
  costUsd: number;
  /** Whether the answer reported its cost: a generation's cost comes only from a response that says it. */
  billed: boolean;
  /** The answers as Jev wrote them, before any default: what its generation shows. */
  decoded: Record<string, unknown>;
  /** The upstream decision id, for audit. */
  id: string;
  /** Wall time of the call, retries included. */
  ms: number;
  /** The tokens as Jev reports them; 0 when it reports none. */
  inputTokens: number;
  outputTokens: number;
}

export interface JevOptions {
  /** OpenRouter's bearer key. */
  key: string;
  /** The OpenRouter id of Jev, pinned: "typesafe/jev-1.13". */
  model?: string;
  url?: string;
  fetch?: typeof fetch;
  /** The most a call may take, whatever the request's own budget. */
  timeoutMs?: number;
  /**
   * How many calls a request may take when the failure is transient (a rate
   * limit, an overload, a reset), `retryWaitMs` apart and doubling. 1, the
   * default, retries nothing: a customer waiting on a quote would rather
   * have an answer at once.
   */
  attempts?: number;
  retryWaitMs?: number;
}

/**
 * What a set of requests spent so far: the requests that went out, answered
 * or not, and the cost of the answers that came in time. Kept by the caller,
 * so that a set that fails still says what it spent.
 */
export interface Tally {
  sent: number;
  costUsd: number;
}

/** How many requests decideAll keeps open at once: a long cart is hundreds of questions, and OpenRouter caps Jev's rate. */
const IN_FLIGHT = 16;

/** The most of an answer read: a decision is a few hundred bytes. */
const MAX_ANSWER_BYTES = 256 * 1024;

/** The statuses worth waiting out: a rate limit, an overload (529), a reset, Cloudflare's 52x. */
const TRANSIENT = new Set([429, 500, 502, 503, 504, 520, 522, 524, 529]);

export class Jev {
  /** The engine, as usage and traces name it: "jev-1.13". */
  readonly engine: string;
  readonly model: string;
  readonly #options: Required<Omit<JevOptions, 'model'>>;

  constructor({ model = JEV_MODEL, ...options }: JevOptions) {
    this.model = model;
    this.engine = model.slice(model.lastIndexOf('/') + 1);
    this.#options = {
      url: JEV_URL,
      fetch: globalThis.fetch,
      timeoutMs: 20_000,
      attempts: 1,
      retryWaitMs: 5000,
      ...options,
    };
  }

  /**
   * Sends one request and checks the answer. The call is a Langfuse
   * generation, with its input, its answers, its cost and its tokens.
   */
  async decide(request: Request, signal: AbortSignal): Promise<Decision> {
    const questions = Object.fromEntries(
      request.questions.map((q) => [q.key, { type: q.kind, instructions: q.instructions, criteria: q.criteria }]),
    );
    const body = JSON.stringify(sortedKeys({ model: this.model, state: request.state, questions }));
    return observe(`decide ${this.engine}`, 'generation', async (generation) => {
      generation.update({ model: this.model, input: body });
      const started = performance.now();
      try {
        const decision = await this.#send(body, request, signal);
        decision.ms = Math.round(performance.now() - started);
        generation.update({
          output: decision.decoded,
          ...(decision.billed && { costDetails: { total: decision.costUsd } }),
          // no count, no details: a 0 would read as a free call
          ...((decision.inputTokens > 0 || decision.outputTokens > 0) && {
            usageDetails: { input: decision.inputTokens, output: decision.outputTokens },
          }),
        });
        return decision;
      } catch (error) {
        if (!isCancelled(signal)) generation.fail(error);
        throw error;
      }
    });
  }

  /**
   * Sends the requests side by side, at most IN_FLIGHT at once, and returns
   * their decisions in the order of the requests. The first failure stops
   * the rest: one missing answer fails the whole set.
   *
   * `tally`, when given, counts a request as it leaves, not as its answer
   * comes (answered, failed or cancelled, it was sent: a request not sent
   * because the set was already stopped is not counted), and adds the cost of
   * each answer that comes; after a failure the decisions are lost, what the
   * set spent is not.
   */
  async decideAll(requests: readonly Request[], signal: AbortSignal, tally?: Tally): Promise<Decision[]> {
    const stop = new AbortController();
    const each = AbortSignal.any([signal, stop.signal]);
    const decisions = new Array<Decision>(requests.length);
    const queue = requests.entries();
    const worker = async () => {
      for (const [i, request] of queue) {
        if (each.aborted) return;
        if (tally) tally.sent += 1;
        const decision = await this.decide(request, each);
        decisions[i] = decision;
        if (tally) tally.costUsd += decision.costUsd;
      }
    };
    const workers = Array.from({ length: Math.min(IN_FLIGHT, requests.length) }, () =>
      worker().catch((error: unknown) => {
        stop.abort(error);
        throw error;
      }),
    );
    const results = await Promise.allSettled(workers);
    // the failure that stopped the others, not what stopping did to them
    if (stop.signal.aborted) throw stop.signal.reason;
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
    return decisions;
  }

  /** One call, and as many again as `attempts` allows while the failure is transient. */
  async #send(body: string, request: Request, signal: AbortSignal): Promise<Decision> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#call(body, request, signal);
      } catch (error) {
        if (!(error instanceof JevError) || !error.transient || attempt >= this.#options.attempts) throw error;
        await wait(this.#options.retryWaitMs * 2 ** (attempt - 1), signal);
      }
    }
  }

  async #call(body: string, request: Request, signal: AbortSignal): Promise<Decision> {
    const { url, key, fetch, timeoutMs } = this.#options;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/func-it/delorean',
          'X-Title': 'delorean',
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (cause) {
      if (signal.aborted) throw new JevError(`${this.engine}: cancelled`, false, { cause: signal.reason });
      // a call that outlasts its own timeout is the network's failure, worth a retry
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      throw new JevError(`${this.engine}: ${timedOut ? 'no answer in time' : 'unreachable'}`, timedOut, { cause });
    }
    const text = await readText(response, MAX_ANSWER_BYTES);
    const transient = TRANSIENT.has(response.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JevError(`${this.engine}: status ${response.status}: bad JSON: ${text.slice(0, 200)}`, transient);
    }
    if (!isObject(parsed)) {
      throw new JevError(`${this.engine}: status ${response.status}: not a decision: ${text.slice(0, 200)}`, transient);
    }
    const wire = parsed as Wire;
    if (response.status !== 200 || wire.error) {
      throw new JevError(`${this.engine}: status ${response.status}: ${wire.error?.message ?? ''}`, transient);
    }
    const usage = wire.usage ?? {};
    const decision: Decision = {
      answers: answersOf(wire.answers, request, this.engine),
      costUsd: number(usage.cost),
      billed: typeof usage.cost === 'number',
      decoded: wire.answers ?? {},
      id: wire.id ?? '',
      ms: 0,
      inputTokens: number(usage.input_tokens) || number(usage.prompt_tokens),
      outputTokens: number(usage.output_tokens) || number(usage.completion_tokens),
    };
    return decision;
  }
}

/** A failure of Jev, which the pipeline answers 502; `transient` ones are worth a retry. */
export class JevError extends EngineError {
  override name = 'JevError';
  readonly transient: boolean;

  constructor(message: string, transient: boolean, options?: ErrorOptions) {
    super(message, options);
    this.transient = transient;
  }
}

/** A decision as Jev writes it; the token counts come under either spelling OpenRouter uses. */
interface Wire {
  id?: string;
  /** Each answer is checked before it is read: see answersOf. */
  answers?: Record<string, unknown>;
  usage?: {
    cost?: number;
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * The answers, checked against the questions: an answer missing, a choice
 * outside the question's options, a probability outside [0, 1] is an engine
 * that drifts — an error, not a verdict. So is a noul question answered
 * without its `noul` probability: an answer that does not say is no answer,
 * and `noul: 0` is one. (The other keys left out read as 0 or empty, as in
 * the other implementations.)
 */
function answersOf(wire: Wire['answers'], request: Request, engine: string): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const q of request.questions) {
    const given = wire?.[q.key];
    if (!isObject(given)) throw new JevError(`${engine}: no answer for ${JSON.stringify(q.key)}`, false);
    const a = given as Partial<Answer>;
    if (q.kind === 'noul' && a.noul === undefined) {
      throw new JevError(`${engine}: ${JSON.stringify(q.key)} has no noul probability`, false);
    }
    const answer: Answer = { noul: a.noul ?? 0, choice: a.choice ?? '', confidence: a.confidence ?? 0 };
    if (a.probabilities) answer.probabilities = a.probabilities;
    if (q.kind === 'choice' && !(typeof answer.choice === 'string' && Object.hasOwn(q.criteria, answer.choice))) {
      throw new JevError(
        `${engine}: ${JSON.stringify(q.key)} answered ${JSON.stringify(answer.choice)}, not one of its options`,
        false,
      );
    }
    if (!isUnit(answer.noul) || !isUnit(answer.confidence)) {
      throw new JevError(`${engine}: ${JSON.stringify(q.key)} answered a probability outside [0, 1]`, false);
    }
    answers[q.key] = answer;
  }
  return answers;
}

/**
 * `value` with the keys of every object in order: the bytes Go's
 * encoding/json writes of a map, so that both implementations put Jev the
 * same request, criteria in the same order.
 */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, sortedKeys(v)]),
  );
}

function isObject(x: unknown): x is object {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isUnit(x: unknown): boolean {
  return typeof x === 'number' && x >= 0 && x <= 1;
}

function number(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** The body as text, its first `limit` bytes. */
async function readText(response: Response, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      chunks.push(chunk.subarray(0, limit - size));
      size += chunk.byteLength;
      if (size >= limit) break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
