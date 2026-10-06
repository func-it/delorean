import { Ajv, type ValidateFunction } from 'ajv';
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { Mention } from '../../cart.ts';
import type { TokenCounter } from '../../prepare/tokens.ts';
import { EngineError, engineFailure, isCancelled, type Finding, type Reader } from '../../pipeline/ports.ts';
import type { ReadingPrompt } from '../../prompts.ts';
import { observe } from '../../telemetry/trace.ts';
import { trimSpace } from '../../text.ts';
import { CUSTOMER_MESSAGE } from './questions.ts';

/**
 * Reads the films a customer buys, and how many copies of each, with an LLM
 * through OpenRouter's OpenAI-compatible API, under a strict JSON schema. The
 * parser and the recount are two readers on two models of different
 * families, with the same instruction and schema.
 *
 * The schema is asked of the model, and its answer is checked against it,
 * never trusted.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export interface ReaderOptions {
  /** OpenRouter's bearer key. */
  key: string;
  /** The OpenRouter id of the model: "openai/gpt-6-luna". */
  model: string;
  /** The reasoning effort asked of the model: "low". */
  effort: string;
  baseURL?: string;
  fetch?: typeof fetch;
  /** The most one call may take, whatever the request's own budget; none when undefined. */
  timeoutMs?: number;
  /**
   * How many times a failed call is tried again (a rate limit, a server error): 0, the default, in the request
   * path, where a customer waits; a bench waits a rate limit out.
   */
  maxRetries?: number;
  /**
   * What a call that ends without the cost OpenRouter bills (cut by its time, aborted, failed after it was
   * sent) is counted for: the tokens of what it sent, at `usdPerMTok` per million. An estimate, so that the
   * daily budget does not take such calls for free; none (cost 0) when undefined or `usdPerMTok` is 0.
   */
  estimate?: { counter: TokenCounter; usdPerMTok: number };
}

/** Reasoning included; a reading is a few hundred tokens. */
const MAX_TOKENS = 4096;

export function llmReader(prompts: ReadingPrompt, options: ReaderOptions): Reader {
  const { model, effort } = options;
  const client = new OpenAI({
    apiKey: options.key,
    baseURL: options.baseURL ?? OPENROUTER_URL,
    defaultHeaders: { 'HTTP-Referer': 'https://github.com/func-it/delorean', 'X-Title': 'delorean' },
    // no retry in the request path, where a customer waits: a failure is a 502 at once
    maxRetries: options.maxRetries ?? 0,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const valid = new Ajv({ strict: true, allErrors: true }).compile(prompts.schema);

  return {
    async read(text, call, retry) {
      const signal =
        options.timeoutMs === undefined
          ? call.signal
          : AbortSignal.any([call.signal, AbortSignal.timeout(options.timeoutMs)]);
      // OpenRouter reports the real cost of each call when asked to
      const body: ChatCompletionCreateParamsNonStreaming & { usage: { include: true } } = {
        model,
        messages: [
          { role: 'system', content: prompts.instruction },
          { role: 'user', content: prompts.message.before + escapeFence(text) + prompts.message.after },
          // read again: the conversation goes on from the reading the judge refused
          ...(retry
            ? [
                { role: 'assistant' as const, content: readingJSON(retry.previous) },
                { role: 'user' as const, content: retryTurn(prompts.retry, retry.failed) },
              ]
            : []),
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'reading',
            schema: prompts.schema,
            strict: true,
          },
        },
        // a model without reasoning refuses the field: effort none sends none
        ...(effort !== 'none' && { reasoning_effort: effort as ReasoningEffort }),
        max_completion_tokens: MAX_TOKENS,
        usage: { include: true },
      };
      return observe(`chat ${model}`, 'generation', async (generation) => {
        generation.update({ model, input: body.messages, modelParameters: { reasoning_effort: effort } });
        const started = performance.now();
        const usage = (calls: number, costUsd = 0) => ({
          engine: model,
          model,
          calls,
          ms: Math.round(performance.now() - started),
          costUsd,
        });
        let completion: ChatCompletion | undefined;
        try {
          completion = await client.chat.completions.create(body, { signal });
          const billed = costOf(completion);
          const costUsd = billed ?? 0;
          const content = completion.choices[0]?.message.content ?? '';
          generation.update({
            output: content,
            ...(billed !== undefined && { costDetails: { total: billed } }),
            ...(completion.usage && {
              usageDetails: { input: completion.usage.prompt_tokens, output: completion.usage.completion_tokens },
            }),
          });
          return { mentions: decodeReading(completion, valid, model), usage: usage(1, costUsd) };
        } catch (error) {
          if (!isCancelled(signal)) generation.fail(error);
          // a call answered counts, and costs, even off schema
          // the call went out, answered or not: one cut by its time counts, and costs what its input is
          // estimated at, as nothing says what it cost
          const billed = completion ? costOf(completion) : undefined;
          throw engineFailure(error, usage(1, billed ?? estimatedCost(body.messages, options.estimate)));
        }
      });
    },
  };
}

/** The estimate of a call's cost from its input: the tokens of its messages × the price per million; 0 when off. */
function estimatedCost(
  messages: ChatCompletionCreateParamsNonStreaming['messages'],
  estimate: ReaderOptions['estimate'],
) {
  if (!estimate || estimate.usdPerMTok <= 0) return 0;
  let tokens = 0;
  for (const { content } of messages) tokens += typeof content === 'string' ? estimate.counter.count(content) : 0;
  return (tokens * estimate.usdPerMTok) / 1_000_000;
}

/** A reading as the model answers it: `{"films":[{"title":…,"quantity":…}]}`, compact. */
function readingJSON(mentions: readonly Mention[]): string {
  return JSON.stringify({ films: mentions.map(({ title, quantity }) => ({ title, quantity })) });
}

/** The closing tag of the fence the customer's text is put in, in any case mix. */
const CLOSING_TAG = new RegExp(`</(${CUSTOMER_MESSAGE})`, 'gi');

/**
 * Writes every closing tag of the fence in `text` as `<\/` and the name as written, so that a text put
 * between the tags cannot close them.
 */
export function escapeFence(text: string): string {
  return text.replace(CLOSING_TAG, '<\\/$1');
}

/** The blanks a label's runs are collapsed on: space, \t \n \v \f \r, U+0085, U+2028 and U+2029. */
const LABEL_BLANKS = /[ \t\n\v\f\r\u0085\u2028\u2029]+/;

/**
 * A finding's label as the retry turn lists it: every run of blanks one space, none at either end, and the
 * fence's closing tag escaped, so that a label can neither add a line nor close the fence.
 */
export function tidyLabel(label: string): string {
  return escapeFence(
    label
      .split(LABEL_BLANKS)
      .filter((word) => word !== '')
      .join(' '),
  );
}

/**
 * The turn that asks for a new reading: one finding line per failing check, in the judgement's order. The
 * label is tidied (tidyLabel); the check and the meaning are ours.
 */
export function retryTurn(retry: ReadingPrompt['retry'], failed: readonly Finding[]): string {
  const lines = failed.map((f) =>
    retry.finding.replace(/\{(check|label|meaning)\}/g, (_, field: string) =>
      field === 'check' ? f.check : field === 'label' ? tidyLabel(f.label) : retry.meanings[f.check],
    ),
  );
  // a function, so that a `$` in a title is written as it is
  return retry.turn.replace('{findings}', () => lines.join('\n'));
}

/** The cost OpenRouter adds to the usage when asked: USD, undefined when the answer does not say it. */
function costOf(completion: ChatCompletion): number | undefined {
  const cost: unknown = (completion.usage as { cost?: unknown } | undefined)?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/**
 * The reading in an answer, held to its schema: JSON and nothing else, a
 * list of films, each with a title that is not blank and at least one copy.
 */
function decodeReading(completion: ChatCompletion, valid: ValidateFunction, model: string): Mention[] {
  const choice = completion.choices[0];
  if (!choice) throw new EngineError(`${model}: no answer`);
  if (choice.finish_reason === 'length') throw new EngineError(`${model}: answer cut short at ${MAX_TOKENS} tokens`);
  const { content, refusal } = choice.message;
  if (refusal) throw new EngineError(`${model}: refused: ${refusal}`);
  let reading: unknown;
  try {
    reading = JSON.parse(content ?? '');
  } catch {
    throw new EngineError(`${model}: answer off schema: not JSON: ${(content ?? '').slice(0, 200)}`);
  }
  if (!valid(reading)) {
    throw new EngineError(`${model}: answer off schema: ${JSON.stringify(valid.errors)}`);
  }
  const { films } = reading as { films: Mention[] };
  return films.map((film, i) => {
    const title = trimSpace(film.title);
    if (title === '') throw new EngineError(`${model}: answer off schema: film ${i + 1} has no title`);
    return { title, quantity: film.quantity };
  });
}
