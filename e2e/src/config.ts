import type { Health } from './contract.ts';

export const DEFAULT_BASE_URL = 'http://localhost:24793';

export function baseUrlFrom(env: NodeJS.ProcessEnv): string {
  return env.BASE_URL ?? DEFAULT_BASE_URL;
}

/**
 * Live engines bill every model call to OpenRouter: nothing plays against
 * them unless RUN_LIVE=1 says so. Returns why a run is refused, if it is.
 */
export function liveRefusal(health: Health, env: NodeJS.ProcessEnv): string | undefined {
  if (health.engines !== 'live' || env.RUN_LIVE === '1') return undefined;
  return (
    `The ${health.implementation} quoter runs live engines: every request costs OpenRouter credit. ` +
    'Set RUN_LIVE=1 to run against it anyway.'
  );
}
