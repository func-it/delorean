import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseDuration } from '../src/config.ts';
import { DEFAULT_PROMPTS_DIR, loadPrompts, promptVersion, promptVersions } from '../src/prompts.ts';

describe('loadConfig', () => {
  it('takes the defaults of docs/architecture.md, PORT 24793', () => {
    expect(loadConfig({ OPENROUTER_API_KEY: 'k' })).toEqual({
      port: 24793,
      engines: 'live',
      live: {
        openRouterKey: 'k',
        parseModel: 'openai/gpt-6-luna',
        parseEffort: 'minimal',
        parseBaseUrl: 'https://openrouter.ai/api/v1',
        parseIdentifies: false,
        recountModel: 'deepseek/deepseek-v4.1-flash',
        recountEffort: 'low',
        recountBaseUrl: 'https://openrouter.ai/api/v1',
        jevModel: 'typesafe/jev-1.13',
        identifyCacheSize: 10_000,
      },
      maxBodyBytes: 65536,
      maxInputTokens: 2048,
      guardMinConfidence: 0.5,
      judgeThreshold: 0.5,
      readAttempts: 3,
      requestTimeoutMs: 30_000,
      fake: { latency: 'off', cpuMs: 0 },
      promptsDir: DEFAULT_PROMPTS_DIR,
    });
  });

  it('reads every variable', () => {
    const config = loadConfig({
      PORT: '9090',
      ENGINES: 'fake',
      PARSE_MODEL: 'p',
      PARSE_EFFORT: 'high',
      PARSE_BASE_URL: 'http://localhost:11434/v1',
      PARSE_IDENTIFIES: 'true',
      RECOUNT_BASE_URL: 'https://example.test/v1',
      RECOUNT_MODEL: 'r',
      RECOUNT_EFFORT: 'medium',
      JEV_MODEL: 'typesafe/jev-2.0',
      MAX_BODY_BYTES: '1024',
      MAX_INPUT_TOKENS: '100',
      GUARD_MIN_CONFIDENCE: '0.7',
      JUDGE_THRESHOLD: '0.6',
      READ_ATTEMPTS: '1',
      REQUEST_TIMEOUT: '1m30s',
      PROMPTS_DIR: '/prompts',
    });
    expect(config).toMatchObject({
      port: 9090,
      engines: 'fake',
      live: {
        parseModel: 'p',
        parseEffort: 'high',
        recountModel: 'r',
        recountEffort: 'medium',
        jevModel: 'typesafe/jev-2.0',
      },
      maxBodyBytes: 1024,
      maxInputTokens: 100,
      guardMinConfidence: 0.7,
      judgeThreshold: 0.6,
      readAttempts: 1,
      requestTimeoutMs: 90_000,
      promptsDir: '/prompts',
    });
  });

  it('runs the fake engines without a key', () => {
    expect(loadConfig({ ENGINES: 'fake' }).engines).toBe('fake');
  });

  it('says everything that is wrong at once, one variable per line, in the order of the configuration table', () => {
    expect(() =>
      loadConfig({
        ENGINES: 'live',
        REQUEST_TIMEOUT: '30',
        JUDGE_THRESHOLD: 'half',
        GUARD_MIN_CONFIDENCE: '2',
        MAX_BODY_BYTES: '0',
        PORT: 'eighty',
        LANGFUSE_PUBLIC_KEY: 'pk',
      }),
    ).toThrow(
      [
        'configuration:',
        'PORT="eighty" is not an integer',
        'OPENROUTER_API_KEY is required with ENGINES=live; set it, or run ENGINES=fake for the deterministic test engines',
        'MAX_BODY_BYTES must be at least 1',
        'GUARD_MIN_CONFIDENCE must be between 0 and 1',
        'JUDGE_THRESHOLD="half" is not a number',
        'REQUEST_TIMEOUT="30" is not a duration such as "30s"',
        'Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing',
      ].join('\n'),
    );
  });

  it('refuses an effort, a base URL or a boolean it cannot read', () => {
    expect(() =>
      loadConfig({
        ENGINES: 'fake',
        PARSE_EFFORT: 'max',
        RECOUNT_BASE_URL: 'ftp://models',
        PARSE_IDENTIFIES: 'yes',
      }),
    ).toThrow(
      [
        'configuration:',
        'PARSE_EFFORT is "max", want one of none, minimal, low, medium, high',
        'PARSE_IDENTIFIES="yes" is not true or false',
        'RECOUNT_BASE_URL is "ftp://models", not an http(s) URL',
      ].join('\n'),
    );
  });

  it('reads the fake pace, and says what is wrong with it after REQUEST_TIMEOUT, before Langfuse', () => {
    expect(loadConfig({ ENGINES: 'fake', FAKE_LATENCY: 'real', FAKE_CPU_MS: '5' }).fake).toEqual({
      latency: 'real',
      cpuMs: 5,
    });
    expect(() =>
      loadConfig({
        ENGINES: 'fake',
        FAKE_CPU_MS: '-1',
        FAKE_LATENCY: 'fast',
        REQUEST_TIMEOUT: '1',
        LANGFUSE_PUBLIC_KEY: 'pk',
      }),
    ).toThrow(
      [
        'configuration:',
        'REQUEST_TIMEOUT="1" is not a duration such as "30s"',
        'FAKE_LATENCY is "fast", want off or real',
        'FAKE_CPU_MS must be at least 0',
        'Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing',
      ].join('\n'),
    );
  });

  it('refuses engines it does not know', () => {
    expect(() => loadConfig({ ENGINES: 'mock' })).toThrow('ENGINES is "mock", want live or fake');
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['1m30s', 90_000],
    ['1.5s', 1500],
    ['500ms', 500],
    ['1h', 3_600_000],
    ['.5s', 500],
    ['0', 0],
  ])('reads %s as Go does', (raw, ms) => {
    expect(parseDuration(raw)).toBe(ms);
  });

  it.each(['30', 's', '1d', '30 s', ''])('refuses %j', (raw) => {
    expect(parseDuration(raw)).toBeUndefined();
  });
});

describe('loadPrompts', () => {
  it("reads the repository's prompts, versioned by the SHA-256 of their bytes", () => {
    const prompts = loadPrompts(DEFAULT_PROMPTS_DIR);
    const version = (name: string) => promptVersion(readFileSync(join(DEFAULT_PROMPTS_DIR, name)));
    expect(prompts.guard.version).toBe(version('guard.json'));
    expect(prompts.parse.version).toBe(version('parse.json'));
    expect(prompts.identify.version).toBe(version('identify.json'));
    expect(prompts.judge.version).toBe(version('judge.json'));
    expect(prompts.guard.version).toMatch(/^[0-9a-f]{8}$/);
    expect(prompts.guard.order).toMatchObject({ key: 'order', kind: 'noul' });
    expect(Object.keys(prompts.identify.film.criteria)).toEqual(['bttf_1', 'bttf_2', 'bttf_3', 'other']);
    // the words themselves are prompts/'s, read as written
    const file = (name: string) =>
      JSON.parse(readFileSync(join(DEFAULT_PROMPTS_DIR, name), 'utf8')) as Record<string, unknown>;
    expect(prompts.judge.films).toEqual(file('judge.json').films);
    expect(prompts.parse.message).toEqual(file('parse.json').message);
    expect(prompts.parse.retry).toEqual(file('parse.json').retry);
    expect(prompts.parseFilms.version).toBe(version('parse-films.json'));
    expect([prompts.parse.films, prompts.parseFilms.films]).toEqual([false, true]);
    expect(promptVersions(prompts, true).parse).toBe(prompts.parseFilms.version);
    expect(promptVersions(prompts).parse).toBe(prompts.parse.version);
  });

  it('stops at a prompt file that lacks a question, naming the file and the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    for (const name of ['guard.json', 'parse.json', 'parse-films.json', 'identify.json', 'judge.json']) {
      writeFileSync(join(dir, name), readFileSync(join(DEFAULT_PROMPTS_DIR, name)));
    }
    const judge = JSON.parse(readFileSync(join(dir, 'judge.json'), 'utf8')) as Record<string, unknown>;
    delete judge.missing;
    writeFileSync(join(dir, 'judge.json'), JSON.stringify(judge));
    expect(() => loadPrompts(dir)).toThrow('judge.json: missing must be an object');
  });

  it('says where to look when the directory is wrong', () => {
    expect(() => loadPrompts('/nowhere')).toThrow('set PROMPTS_DIR');
  });
});

describe('Langfuse in the configuration', () => {
  const fake = { ENGINES: 'fake' };

  it('is off when nothing is set', () => {
    expect(loadConfig(fake).langfuse).toBeUndefined();
  });

  it('reads the keys, the base URL, the environment and the release', () => {
    expect(
      loadConfig({
        ...fake,
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
        LANGFUSE_BASE_URL: 'http://localhost:24794/',
        LANGFUSE_TRACING_ENVIRONMENT: 'staging',
        LANGFUSE_RELEASE: 'r1',
      }).langfuse,
    ).toEqual({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'http://localhost:24794',
      environment: 'staging',
      release: 'r1',
    });
  });

  it('takes LANGFUSE_HOST as a URL, as the Langfuse SDKs read it', () => {
    const env = { ...fake, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    expect(loadConfig({ ...env, LANGFUSE_HOST: 'https://eu.cloud.langfuse.com/' }).langfuse?.baseUrl).toBe(
      'https://eu.cloud.langfuse.com',
    );
    expect(() => loadConfig({ ...env, LANGFUSE_HOST: 'localhost:3000' })).toThrow(
      'LANGFUSE_BASE_URL is "localhost:3000", not an http(s) URL',
    );
  });

  it.each([
    [{ LANGFUSE_PUBLIC_KEY: 'pk' }, 'LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST)'],
    [{ LANGFUSE_HOST: 'http://x' }, 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY'],
    [{ LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_BASE_URL: 'http://x' }, 'LANGFUSE_PUBLIC_KEY'],
  ])('says a half setting in the configuration block, the missing variables listed', (set, missing) => {
    expect(() => loadConfig({ ...fake, ...set })).toThrow(
      `configuration:\nLangfuse is half configured: ${missing} missing`,
    );
  });
});
