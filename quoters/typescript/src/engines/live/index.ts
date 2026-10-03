import type { LiveConfig } from '../../config.ts';
import type { Engines } from '../../pipeline/ports.ts';
import type { Prompts } from '../../prompts.ts';
import { Agent } from 'undici';
import { cachedIdentifier, Lru } from './cache.ts';
import { Jev, type JevOptions } from './jev.ts';
import { jevGuard, jevIdentifier, jevJudge } from './questions.ts';
import { llmReader } from './reader.ts';

/**
 * The engines on real models, through OpenRouter: Jev for the guard, the
 * identification and the judge; two LLMs of different families for the
 * parse and the recount.
 *
 * Two kinds of model, each for what it does well. Jev answers a typed
 * question with calibrated probabilities and never writes prose: it decides.
 * It does not count or extract (it recognises the shape instead of
 * counting), so the LLMs read the titles and quantities out of the free text,
 * and Jev's judge then holds that reading against the text before anything is
 * priced. Building them calls nothing: the first call is the first quote.
 */
export function liveEngines(config: LiveConfig, prompts: Prompts, fetch?: typeof globalThis.fetch): Engines {
  const key = config.openRouterKey;
  if (key === '') throw new Error('live engines: OPENROUTER_API_KEY is required');
  // one pool of kept-alive connections per engine: Jev's bursts of a quote's
  // calls, the parse's and the recount's each reuse their own connections
  const [jevAgent, parseAgent, recountAgent] = [new Agent(KEEP_ALIVE), new Agent(KEEP_ALIVE), new Agent(KEEP_ALIVE)];
  const jev = new Jev({ key, model: config.jevModel, fetch: fetch ?? pooled(jevAgent) } satisfies JevOptions);
  const parser = llmReader(config.parseIdentifies ? prompts.parseFilms : prompts.parse, {
    key,
    model: config.parseModel,
    effort: config.parseEffort,
    baseURL: config.parseBaseUrl,
    fetch: fetch ?? pooled(parseAgent),
  });
  const recounter = llmReader(prompts.parse, {
    key,
    model: config.recountModel,
    effort: config.recountEffort,
    baseURL: config.recountBaseUrl,
    fetch: fetch ?? pooled(recountAgent),
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

/** Node's fetch, its connections from `agent`'s pool. */
export function pooled(agent: Agent): typeof globalThis.fetch {
  // undici's Agent is the dispatcher Node's fetch takes; the npm package's types and Node's bundled ones differ only in name
  const dispatcher = agent as unknown as NonNullable<RequestInit['dispatcher']>;
  return (input, init) => globalThis.fetch(input, { ...init, dispatcher });
}
