/**
 * delorean prices a free-text DVD cart with the Back to the Future
 * promotion: models read the cart, code computes the price. This is the HTTP
 * API of api/openapi.yaml, configured by the environment.
 *
 *     delorean [serve]     the API
 *     delorean healthcheck asks the running service for /healthz: exit 0 when it is up
 *     delorean version     the version of this build
 *     delorean tokenizer   the o200k_base vocabulary, offline: how many ranks it has
 */
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { loadConfig, type Config } from './config.ts';
import { fakeEngines } from './engines/fake.ts';
import { liveEngines } from './engines/live/index.ts';
import { createApp } from './http/app.ts';
import { healthcheck } from './healthcheck.ts';
import { jsonLogger, type Logger } from './log.ts';
import { Pipeline } from './pipeline/pipeline.ts';
import type { Engines } from './pipeline/ports.ts';
import { TokenCounter } from './prepare/tokens.ts';
import { DEFAULT_CATALOG } from './pricing.ts';
import { loadPrompts, promptVersions, type Prompts } from './prompts.ts';
import { startTracing } from './telemetry/langfuse.ts';

/** Set at build time (the Dockerfile's VERSION), "dev" otherwise. */
const VERSION = process.env.DELOREAN_VERSION ?? 'dev';

/** A command line the program does not take: exit code 2. */
class UsageError extends Error {
  override name = 'UsageError';
}

async function main(args: string[]): Promise<void> {
  const [command = 'serve', extra] = args;
  if (!['serve', 'healthcheck', 'version', 'tokenizer'].includes(command)) {
    throw new UsageError(`unknown command ${JSON.stringify(command)}: want serve, healthcheck, version or tokenizer`);
  }
  if (extra !== undefined) throw new UsageError(`unexpected argument ${JSON.stringify(extra)}`);
  if (command === 'healthcheck') {
    await healthcheck(process.env);
  } else if (command === 'version') {
    console.log(VERSION);
  } else if (command === 'tokenizer') {
    // the vocabulary ships in the package: nothing to fetch, only to count
    console.log(`o200k_base: ${new TokenCounter().ranks} ranks`);
  } else {
    await run(loadConfig(process.env), jsonLogger());
  }
}

async function run(config: Config, log: Logger): Promise<void> {
  const tracing = startTracing(config.langfuse, { version: VERSION, log });
  // read whatever the engines: /healthz names the versions the service runs
  const prompts = loadPrompts(config.promptsDir);
  const counter = new TokenCounter();
  const engines = newEngines(config, prompts, log, counter);
  const pipeline = new Pipeline({
    engines,
    counter,
    catalog: DEFAULT_CATALOG,
    maxInputTokens: config.maxInputTokens,
    guardMinConfidence: config.guardMinConfidence,
    judgeThreshold: config.judgeThreshold,
    readAttempts: config.readAttempts,
    recountTimeoutMs: config.recountTimeoutMs,
  });
  const app = createApp({
    pipeline,
    version: VERSION,
    prompts: promptVersions(prompts),
    tracing,
    maxBodyBytes: config.maxBodyBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    log,
  });

  const server = await listen(app.fetch, config.port);
  server.headersTimeout = 5_000;
  // the time to receive a request; the request's own budget then runs in the pipeline
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 60_000;
  log.log('INFO', 'listening', {
    addr: `:${config.port}`,
    version: VERSION,
    engines: engines.name,
    tracing: tracing.enabled,
    prompts: promptVersions(prompts),
  });

  const signal = await stopSignal();
  log.log('INFO', 'shutting down', { signal });
  // requests under way get their own budget to finish, then the last spans go out
  const drained = AbortSignal.timeout(config.requestTimeoutMs + 5_000);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    drained.addEventListener('abort', () => {
      resolve();
    });
  });
  await engines.close?.();
  await tracing.shutdown().catch((error: unknown) => {
    log.log('WARN', 'traces not flushed', { err: String(error) });
  });
}

/** The engines `config` names. */
function newEngines(config: Config, prompts: Prompts, log: Logger, counter: TokenCounter): Engines {
  if (config.engines === 'live') return liveEngines(config.live, prompts, undefined, counter);
  log.log('WARN', 'fake engines: deterministic stand-ins for tests, never in production');
  return fakeEngines();
}

/** The HTTP server, once it listens. */
function listen(fetch: Parameters<typeof serve>[0]['fetch'], port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // serve makes an HTTP/1.1 server unless told otherwise
    const server = serve({ fetch, port }, () => {
      resolve(server as Server);
    });
    server.once('error', reject);
  });
}

function stopSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        resolve(signal);
      });
    }
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // usage and configuration errors go to stderr; a usage error exits 2, any other 1
  console.error(`delorean: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
