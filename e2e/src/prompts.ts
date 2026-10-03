import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Health } from './contract.ts';

/** The repository's prompts: every word the implementations put to a model. */
export const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);

/** The version of each prompt file: the first 8 hex digits of the SHA-256 of its bytes. */
export function promptVersions(dir: URL = PROMPTS_DIR): Health['prompts'] {
  const version = (file: string) =>
    createHash('sha256')
      .update(readFileSync(new URL(file, dir)))
      .digest('hex')
      .slice(0, 8);
  return {
    guard: version('guard.json'),
    parse: version('parse.json'),
    identify: version('identify.json'),
    judge: version('judge.json'),
  };
}
