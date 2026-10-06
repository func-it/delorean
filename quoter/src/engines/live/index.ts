import type { LiveConfig } from '../../config.ts';
import type { Engines } from '../../pipeline/ports.ts';
import type { TokenCounter } from '../../prepare/tokens.ts';
import type { Prompts } from '../../prompts.ts';
import { Agent, fetch as undiciFetch } from 'undici';
import { cachedIdentifier, Lru } from './cache.ts';
import { Jev, type JevOptions } from './jev.ts';
import { jevGuard, jevIdentifier, jevJudge } from './questions.ts';
import { llmReader } from './reader.ts';

/**
 * The engines on real models, through OpenRouter: Jev for the guard, the
 * identification and the judge; an LLM for the parse and the recount
 * (GPT-6 Luna by default, the recount without reasoning, for speed). Each
 * model call is bounded by MODEL_TIMEOUT, and a reading cut before it was billed counts for its input tokens.
 *
 * Two kinds of model, each for what it does well. Jev answers a typed
 * question with calibrated probabilities and never writes prose: it decides.
 * It does not count or extract (it recognises the shape instead of
 * counting), so the LLMs read the titles and quantities out of the free text,
 * and Jev's judge then holds that reading against the text before anything is
 * priced. Building them calls nothing: the first call is the first quote.
 */
export function liveEngines(
  config: LiveConfig,
  prompts: Prompts,
  fetch?: typeof globalThis.fetch,
  counter?: TokenCounter,
): Engines {
  const key = config.openRouterKey;
  if (key === '') throw new Error('live engines: OPENROUTER_API_KEY is required');
  // one pool of kept-alive connections per engine: Jev's bursts of a quote's
  // calls, the parse's and the recount's each reuse their own connections
  const [jevAgent, parseAgent, recountAgent] = [new Agent(KEEP_ALIVE), new Agent(KEEP_ALIVE), new Agent(KEEP_ALIVE)];
  const jev = new Jev({
    key,
    model: config.jevModel,
    fetch: fetch ?? pooled(jevAgent),
    timeoutMs: config.modelTimeoutMs,
  } satisfies JevOptions);
  // a reading cut before OpenRouter bills it is counted for its input (INPUT_USD_PER_MTOK), when there is a counter
  const estimate = counter && { estimate: { counter, usdPerMTok: config.inputUsdPerMTok } };
  const parser = llmReader(prompts.parse, {
    key,
    model: config.parseModel,
    effort: config.parseEffort,
    baseURL: config.parseBaseUrl,
    fetch: fetch ?? pooled(parseAgent),
    timeoutMs: config.modelTimeoutMs,
    ...estimate,
  });
  const recounter = llmReader(prompts.parse, {
    key,
    model: config.recountModel,
    effort: config.recountEffort,
    baseURL: config.recountBaseUrl,
    fetch: fetch ?? pooled(recountAgent),
    timeoutMs: config.modelTimeoutMs,
    ...estimate,
  });
  const identifier = cachedIdentifier(
    jevIdentifier(jev, prompts.identify),
    new Lru(config.identifyCacheSize),
    `${prompts.identify.version} ${jev.model}`,
    { engine: jev.engine, calls: 0, costUsd: 0 },
  );
  return {
    name: 'live',
    guard: jevGuard(jev, prompts.guard),
    parser,
    recounter,
    identifier,
    judge: jevJudge(jev, prompts.judge),
    close: () => Promise.all([jevAgent, parseAgent, recountAgent].map((a) => a.close())).then(() => undefined),
  };
}

/** Connections kept open between calls, a quote's calls coming in bursts. */
const KEEP_ALIVE = { keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 32 };

/**
 * A fetch whose connections come from `agent`'s pool. It is the npm undici's own fetch that takes the npm
 * undici's Agent: Node's built-in fetch carries its own undici, of another major version on each Node line, and
 * refuses a dispatcher from a different one (« invalid onRequestStart method » on Node 22).
 */
export function pooled(agent: Agent): typeof globalThis.fetch {
  return (input, init) => undiciFetch(input, { ...init, dispatcher: agent });
}
