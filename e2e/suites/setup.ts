import type { TestProject } from 'vitest/node';
import { api, fetchHealth } from '../src/api.ts';
import { baseUrlFrom, liveRefusal } from '../src/config.ts';
import type { Catalog, Health } from '../src/contract.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
    health: Health;
    catalog: Catalog;
  }
}

/** Finds out which backend answers, and refuses live engines unless RUN_LIVE=1. */
export default async function setup(project: TestProject): Promise<void> {
  const baseUrl = baseUrlFrom(process.env);
  const health = await fetchHealth(baseUrl);
  const refusal = liveRefusal(health, process.env);
  if (refusal) throw new Error(refusal);

  const { data: catalog } = await api(baseUrl).GET('/v1/catalog');
  if (!catalog) throw new Error(`GET ${baseUrl}/v1/catalog answered no catalog`);

  console.info(`e2e: ${health.implementation} ${health.version}, ${health.engines} engines, at ${baseUrl}`);
  project.provide('baseUrl', baseUrl);
  project.provide('health', health);
  project.provide('catalog', catalog);
}
