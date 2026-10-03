import type { Mention } from '../src/cart.ts';
import { fakeEngines } from '../src/engines/fake.ts';
import { Pipeline, type PipelineConfig, type Quote } from '../src/pipeline/pipeline.ts';
import type { EngineUsage, Engines, Reader } from '../src/pipeline/ports.ts';
import { Rejection } from '../src/pipeline/rejection.ts';
import { TokenCounter } from '../src/prepare/tokens.ts';
import { DEFAULT_CATALOG } from '../src/pricing.ts';

/** One counter for every test: the vocabulary takes a while to decode. */
export const counter = new TokenCounter();

/** A pipeline on the fake engines and the default rules, with the engines a test swaps. */
export function newPipeline(engines: Partial<Engines> = {}, config: Partial<PipelineConfig> = {}): Pipeline {
  return new Pipeline({
    engines: { ...fakeEngines(), ...engines },
    counter,
    catalog: DEFAULT_CATALOG,
    maxInputTokens: 2048,
    guardMinConfidence: 0.5,
    judgeThreshold: 0.5,
    readAttempts: 3,
    ...config,
  });
}

export const free: EngineUsage = { engine: 'stub', calls: 1, costUsd: 0 };

/** A reader that reads these mentions, whatever the text. */
export function reads(...mentions: Mention[]): Reader {
  return { read: () => Promise.resolve({ mentions: structuredClone(mentions), usage: free }) };
}

/** Quotes a cart, never aborted. */
export function quote(pipeline: Pipeline, cart: string): Promise<Quote> {
  return pipeline.quote({ cart }, new AbortController().signal);
}

/** The rejection a quote throws; fails the test when it throws something else, or nothing. */
export async function rejection(promise: Promise<unknown>): Promise<Rejection> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof Rejection)) throw new Error(`want a rejection, got ${String(error)}`);
  return error;
}
