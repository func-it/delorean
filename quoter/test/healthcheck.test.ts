import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { healthcheck } from '../src/healthcheck.ts';

// `delorean healthcheck`, for a container with nothing but the image's own
// tools: a service that is up gives exit 0 and says nothing; anything else,
// one line on stderr and exit 1.

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** A service on a free port answering `/healthz` with `status` and `body`. */
async function service(status: number, body: string): Promise<number> {
  server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A free port with nothing listening on it. */
async function silentPort(): Promise<number> {
  const port = await service(200, '{}');
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  return port;
}

describe('healthcheck', () => {
  it('says nothing and resolves when the service is up', async () => {
    const port = await service(200, '{"status":"ok","implementation":"typescript"}');
    await expect(healthcheck({ PORT: String(port) })).resolves.toBeUndefined();
  });

  it('asks port 24793 when PORT is not set, and 127.0.0.1', async () => {
    const asked: string[] = [];
    const answer: typeof fetch = (url) => {
      asked.push(url as string);
      return Promise.resolve(new Response('{"status":"ok"}'));
    };
    await healthcheck({}, 3000, answer);
    await healthcheck({ PORT: '' }, 3000, answer);
    expect(asked).toEqual(Array(2).fill('http://127.0.0.1:24793/healthz'));
  });

  it('fails in one line when nothing listens', async () => {
    const port = await silentPort();
    await expect(healthcheck({ PORT: String(port) })).rejects.toThrow(`healthcheck: no answer on port ${port}`);
  });

  it('fails on a status that is not 200, and on an answer that is not a quoter health', async () => {
    const down = await service(503, '{"status":"ok"}');
    await expect(healthcheck({ PORT: String(down) })).rejects.toThrow(`healthcheck: HTTP 503 on port ${down}`);
    server?.close();
    const other = await service(200, '<html>not us</html>');
    await expect(healthcheck({ PORT: String(other) })).rejects.toThrow(
      `healthcheck: not the health of a quoter on port ${other}`,
    );
    server?.close();
    const wrong = await service(200, '{"status":"starting"}');
    await expect(healthcheck({ PORT: String(wrong) })).rejects.toThrow('not the health of a quoter');
  });

  it.each(['abc', '0', '70000', '-1', '24793.5', ' 24793'])('refuses PORT=%j: it is not a port', async (port) => {
    await expect(healthcheck({ PORT: port })).rejects.toThrow(
      `healthcheck: PORT=${JSON.stringify(port)} is not a port`,
    );
  });

  it('gives up after its time when the service does not answer', async () => {
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await expect(healthcheck({ PORT: String(port) }, 100)).rejects.toThrow(`no answer on port ${port}`);
  });
});

describe('delorean healthcheck, as a command', () => {
  /** The command as a process of its own (not spawnSync: this loop must answer it), with the environment of a service. */
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [main, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    });

  it('exits 0 and prints nothing when the service is up, whatever else is configured', async () => {
    const port = await service(200, '{"status":"ok"}');
    // a setting that would fail the service's own configuration must not fail the check
    const result = await run(['healthcheck'], { PORT: String(port), REQUEST_TIMEOUT: 'nonsense', ENGINES: 'nope' });
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('exits 1 with one line on stderr when nothing listens', async () => {
    const port = await silentPort();
    const result = await run(['healthcheck'], { PORT: String(port) });
    expect(result).toEqual({
      status: 1,
      stdout: '',
      stderr: `delorean: healthcheck: no answer on port ${port}\n`,
    });
  });

  it('exits 2 on a command it does not know, and says the commands', async () => {
    const result = await run(['help'], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('delorean: unknown command "help": want serve, healthcheck, version or tokenizer\n');
  });
});
