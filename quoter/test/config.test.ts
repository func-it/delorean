import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseDuration } from '../src/config.ts';
import { DEFAULT_PROMPTS_DIR, loadPrompts, promptVersion, promptVersions } from '../src/prompts.ts';

describe('loadConfig', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['', false],
  ])('reads LOG_CARTS=%j as %s', (raw, expected) => {
    expect(loadConfig({ ENGINES: 'fake', LOG_CARTS: raw }).logCarts).toBe(expected);
  });

  it('refuses a LOG_CARTS that is not true, false, 1 or 0', () => {
    expect(() => loadConfig({ ENGINES: 'fake', LOG_CARTS: 'yes' })).toThrow(
      'LOG_CARTS="yes" is not true, false, 1 or 0',
    );
  });

  it('takes the defaults of docs/architecture.md, PORT 24793', () => {
    expect(loadConfig({ OPENROUTER_API_KEY: 'k' })).toEqual({
      port: 24793,
      engines: 'live',
      live: {
        openRouterKey: 'k',
        parseModel: 'openai/gpt-6-luna',
        parseEffort: 'minimal',
        parseBaseUrl: 'https://openrouter.ai/api/v1',
        recountModel: 'openai/gpt-6-luna',
        recountEffort: 'none',
        recountBaseUrl: 'https://openrouter.ai/api/v1',
        jevModel: 'typesafe/jev-1.13',
        identifyCacheSize: 10_000,
        modelTimeoutMs: 10_000,
        inputUsdPerMTok: 1,
      },
      maxBodyBytes: 8192,
      maxInputTokens: 256,
      guardMinConfidence: 0.5,
      judgeThreshold: 0.5,
      readAttempts: 3,
      requestTimeoutMs: 25_000,
      recountTimeoutMs: 10_000,
      logCarts: false,
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
      MODEL_TIMEOUT: '2.5s',
      RECOUNT_TIMEOUT: '4s',
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
        modelTimeoutMs: 2_500,
      },
      maxBodyBytes: 1024,
      maxInputTokens: 100,
      guardMinConfidence: 0.7,
      judgeThreshold: 0.6,
      readAttempts: 1,
      requestTimeoutMs: 90_000,
      recountTimeoutMs: 4_000,
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
        RECOUNT_TIMEOUT: '0',
        MODEL_TIMEOUT: 'soon',
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
        'MODEL_TIMEOUT="soon" is not a duration such as "30s"',
        'RECOUNT_TIMEOUT must be positive',
        'REQUEST_TIMEOUT="30" is not a duration such as "30s"',
        'Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing',
      ].join('\n'),
    );
  });

  it('refuses an effort or a base URL it cannot read', () => {
    expect(() =>
      loadConfig({
        ENGINES: 'fake',
        PARSE_EFFORT: 'max',
        RECOUNT_BASE_URL: 'ftp://models',
      }),
    ).toThrow(
      [
        'configuration:',
        'PARSE_EFFORT is "max", want one of none, minimal, low, medium, high',
        'RECOUNT_BASE_URL is "ftp://models", not an http(s) URL',
      ].join('\n'),
    );
  });

  // With live engines a key goes along with every call to a reader's URL: over http it would cross the network
  // in the clear, so http is for the local machine (exactly localhost, 127.0.0.1 and ::1). With fake engines
  // nothing is sent, and nothing is checked.
  describe('a base URL in http when a key goes with it', () => {
    const live = (vars: Record<string, string>) => loadConfig({ ENGINES: 'live', OPENROUTER_API_KEY: 'k', ...vars });

    it('is refused, on the line of its variable, one line each', () => {
      expect(() => live({ PARSE_BASE_URL: 'http://x/v1', RECOUNT_BASE_URL: 'http://example.com:8080/v1' })).toThrow(
        [
          'configuration:',
          'PARSE_BASE_URL is "http://x/v1", not https: a key is sent with it (http is for localhost only)',
          'RECOUNT_BASE_URL is "http://example.com:8080/v1", not https: a key is sent with it (http is for localhost only)',
        ].join('\n'),
      );
    });

    it.each([
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
      'https://example.com/v1',
      'https://localhost/v1',
    ])('passes %s', (base) => {
      expect(() => live({ PARSE_BASE_URL: base, RECOUNT_BASE_URL: base })).not.toThrow();
    });

    it.each([
      'http://localhost.example.com/v1',
      'http://127.0.0.1.nip.io/v1',
      'http://127.0.0.2/v1',
      'http://[::2]/v1',
      'http://LOCALHOST.evil/v1',
      'http://LOCALHOST/v1',
      'http://127.1/v1',
      'HTTP://example.com/v1',
    ])('refuses %s', (base) => {
      expect(() => live({ PARSE_BASE_URL: base })).toThrow(/^configuration:\nPARSE_BASE_URL is /);
    });

    it('is not checked with fake engines, where nothing is sent', () => {
      expect(() =>
        loadConfig({ ENGINES: 'fake', PARSE_BASE_URL: 'http://example.com/v1', RECOUNT_BASE_URL: 'http://x/v1' }),
      ).not.toThrow();
    });

    it('is not told twice when it is no http(s) URL at all', () => {
      let message = '';
      try {
        live({ PARSE_BASE_URL: 'ftp://x' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.match(/PARSE_BASE_URL/g)).toHaveLength(1);
      expect(message).toContain('not an http(s) URL');
    });
  });

  it('says what is wrong with REQUEST_TIMEOUT before Langfuse', () => {
    expect(() =>
      loadConfig({
        ENGINES: 'fake',
        REQUEST_TIMEOUT: '1',
        LANGFUSE_PUBLIC_KEY: 'pk',
      }),
    ).toThrow(
      [
        'configuration:',
        'REQUEST_TIMEOUT="1" is not a duration such as "30s"',
        'Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing',
      ].join('\n'),
    );
  });

  it('refuses engines it does not know', () => {
    expect(() => loadConfig({ ENGINES: 'mock' })).toThrow('ENGINES is "mock", want live or fake');
  });
});

describe('the three timeouts', () => {
  const fake = { ENGINES: 'fake' };

  it('are ordered: a call, then the recount that holds it, then the request that holds both', () => {
    expect(
      loadConfig({ ...fake, MODEL_TIMEOUT: '1.1s', RECOUNT_TIMEOUT: '2.0004s', REQUEST_TIMEOUT: '9s' }),
    ).toMatchObject({
      live: { modelTimeoutMs: 1100 },
      recountTimeoutMs: 2000,
      requestTimeoutMs: 9000,
    });
    expect(() => loadConfig({ ...fake, MODEL_TIMEOUT: '11s' })).toThrow(
      'RECOUNT_TIMEOUT must be at least MODEL_TIMEOUT',
    );
    expect(() => loadConfig({ ...fake, RECOUNT_TIMEOUT: '30s' })).toThrow(
      'REQUEST_TIMEOUT must be at least RECOUNT_TIMEOUT',
    );
    expect(() => loadConfig({ ...fake, MODEL_TIMEOUT: '20s', RECOUNT_TIMEOUT: '20s', REQUEST_TIMEOUT: '10s' })).toThrow(
      'REQUEST_TIMEOUT must be at least RECOUNT_TIMEOUT',
    );
  });

  it('default to 10 s a call, 10 s for the recount and 25 s a request, in the order the service requires', () => {
    expect(loadConfig(fake)).toMatchObject({
      live: { modelTimeoutMs: 10_000 },
      recountTimeoutMs: 10_000,
      requestTimeoutMs: 25_000,
    });
  });

  it('are not compared when one failed its own check', () => {
    let message = '';
    try {
      loadConfig({ ...fake, RECOUNT_TIMEOUT: '-1s', REQUEST_TIMEOUT: '1s', MODEL_TIMEOUT: '9s' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('configuration:\nRECOUNT_TIMEOUT must be positive');
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
    // whole milliseconds: a float product would give 1100.0000000000002, which AbortSignal.timeout refuses
    ['1.1s', 1100],
    ['2.0004s', 2000],
    ['0.0036s', 4],
  ])('reads %s as time.ParseDuration does', (raw, ms) => {
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
    expect(promptVersions(prompts).parse).toBe(prompts.parse.version);
  });

  it('stops at a prompt file that lacks a question, naming the file and the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    for (const name of ['guard.json', 'parse.json', 'identify.json', 'judge.json']) {
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

describe('INPUT_USD_PER_MTOK', () => {
  const fake = { ENGINES: 'fake' };

  it('is 1 USD per million tokens by default, and may be set, 0 included', () => {
    expect(loadConfig(fake).live.inputUsdPerMTok).toBe(1);
    expect(loadConfig({ ...fake, INPUT_USD_PER_MTOK: '0.25' }).live.inputUsdPerMTok).toBe(0.25);
    expect(loadConfig({ ...fake, INPUT_USD_PER_MTOK: '0' }).live.inputUsdPerMTok).toBe(0);
  });

  it.each(['-1', 'cheap'])('refuses %s before anything starts', (raw) => {
    expect(() => loadConfig({ ...fake, INPUT_USD_PER_MTOK: raw })).toThrow('INPUT_USD_PER_MTOK');
  });
});
