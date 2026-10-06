import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory, removed after the test. */
export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  dirs.push(dir);
  return dir;
}

/** Writes files (path → text or JSON) under a new temporary directory, and returns it. */
export function files(content: Record<string, unknown>): string {
  const dir = tmp();
  for (const [path, value] of Object.entries(content)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

/** A case file's content, with what a test changes. */
export function aCase(id: string, input: unknown, expect: unknown, more: Record<string, unknown> = {}) {
  return { id, note: `why ${id} exists`, tags: ['t'], input, expect, ...more };
}

/** The URL a fetch is given, whichever form it takes. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The JSON a request carries, as an object; the engines and the Langfuse client all send JSON. */
export function jsonOf(init: RequestInit | undefined): Record<string, unknown> {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}
