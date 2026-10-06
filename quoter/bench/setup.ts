import type { Config } from '../src/config.ts';
import type { Prompts } from '../src/prompts.ts';
import type { Setup } from './subjects.ts';

/** The last segment of a model id: "openai/gpt-6-luna" is "gpt-6-luna". */
export function modelName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}

/** Names the models and the rules of `config` for the variant of the runs; the engines are the caller's. */
export function setupOf(config: Config, prompts: Prompts): Omit<Setup, 'engines'> {
  return {
    versions: {
      guard: prompts.guard.version,
      parse: prompts.parse.version,
      identify: prompts.identify.version,
      judge: prompts.judge.version,
    },
    jev: modelName(config.live.jevModel),
    llm: `${modelName(config.live.parseModel)} (${config.live.parseEffort})`,
    recount: `${modelName(config.live.recountModel)} (${config.live.recountEffort})`,
    guardMinConfidence: config.guardMinConfidence,
    judgeThreshold: config.judgeThreshold,
    readAttempts: config.readAttempts,
    recountTimeoutMs: config.recountTimeoutMs,
  };
}
