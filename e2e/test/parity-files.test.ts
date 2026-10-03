import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// What the three quoters share outside their code (docs/architecture.md,
// Identical quoters): the same tasks, the same README sections, images run
// the same way. The parity suite compares the rest, running.

const QUOTERS = ['go', 'typescript', 'python'] as const;

function read(quoter: string, file: string): string {
  return readFileSync(new URL(`../../quoters/${quoter}/${file}`, import.meta.url), 'utf8');
}

describe('the quoters, side by side', () => {
  it('have the same tasks', () => {
    const tasks = (q: string): string[] => {
      const file = parse(read(q, 'Taskfile.yml')) as { tasks: Record<string, { internal?: boolean } | null> };
      return Object.entries(file.tasks)
        .filter(([, t]) => t?.internal !== true)
        .map(([name]) => name)
        .sort();
    };
    expect(tasks('go')).toEqual(['docker', 'format', 'generate', 'lint', 'run', 'run:fake', 'setup', 'test']);
    for (const q of QUOTERS) expect(tasks(q), q).toEqual(tasks('go'));
  });

  it('have READMEs with the same sections', () => {
    const sections = (q: string): string[] => read(q, 'README.md').match(/^## .+$/gm) ?? [];
    expect(sections('go')).toEqual(['## Run', '## Test', '## Configure', '## Layout', '## Choices', '## Benches']);
    for (const q of QUOTERS) expect(sections(q), q).toEqual(sections('go'));
  });

  it.each(QUOTERS)('%s: an image that runs as 65532, its program the entry point, serve the command', (q) => {
    const lines = read(q, 'Dockerfile').split('\n');
    const last = (instruction: string): string | undefined =>
      lines.filter((l) => l.startsWith(`${instruction} `)).at(-1);
    expect(last('USER')).toBe('USER 65532:65532');
    expect(last('ENTRYPOINT')).toMatch(/^ENTRYPOINT \[/);
    expect(last('CMD')).toBe('CMD ["serve"]');
    expect(last('HEALTHCHECK')).toBeUndefined();
  });
});
