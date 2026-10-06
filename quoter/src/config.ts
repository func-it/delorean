import { OPENROUTER_URL } from './engines/live/reader.ts';
import { DEFAULT_PROMPTS_DIR } from './prompts.ts';
import { langfuseFromEnv, type Langfuse } from './telemetry/langfuse.ts';

/** A configuration that cannot run: one line per wrong variable. */
class ConfigurationError extends Error {
  override name = 'ConfigurationError';
  constructor(problems: readonly string[]) {
    super(`configuration:\n${problems.join('\n')}`);
  }
}

/**
 * The service's settings, from the environment (docs/architecture.md,
 * "Configuration"): every variable that is wrong is said before anything
 * starts.
 * Langfuse is configured apart (telemetry/langfuse.ts).
 */
export interface Config {
  port: number;
  /** `live`, the models through OpenRouter, or `fake`, deterministic stand-ins for tests. */
  engines: 'live' | 'fake';
  live: LiveConfig;
  maxBodyBytes: number;
  maxInputTokens: number;
  guardMinConfidence: number;
  judgeThreshold: number;
  /** The most readings of one cart before unfaithful_reading. */
  readAttempts: number;
  /** The budget of one request, model calls included. */
  requestTimeoutMs: number;
  /** The time the recount has, a retry included, before the quote goes on without it. */
  recountTimeoutMs: number;
  /** Where the shared prompts are read from: the repository's prompts/. */
  promptsDir: string;
  /** The Langfuse project traces and scores go to; undefined, no tracing. */
  langfuse?: Langfuse;
}

/** What the live engines need; unused by the fake ones. */
export interface LiveConfig {
  openRouterKey: string;
  parseModel: string;
  /** none (no reasoning field), minimal, low, medium or high. */
  parseEffort: string;
  /** The OpenAI-compatible API of the parse: OpenRouter, or a local server such as Ollama. */
  parseBaseUrl: string;
  recountModel: string;
  recountEffort: string;
  recountBaseUrl: string;
  jevModel: string;
  /** The titles whose film is kept in memory, across requests; 0 keeps none. */
  identifyCacheSize: number;
  /** How long one model call may take, Jev's and the LLMs'. */
  modelTimeoutMs: number;
  /** USD per million input tokens an LLM reading cut before it was billed is counted for; 0 counts nothing. */
  inputUsdPerMTok: number;
}

type Env = Record<string, string | undefined>;

/** Reads the configuration from `env`. Throws one error that lists every variable that is wrong, one per line. */
export function loadConfig(env: Env): Config {
  const problems: { name: string; line: string }[] = [];
  const say = (name: string, line: string) => problems.push({ name, line });
  const read = <T>(name: string, fallback: T, parse: (raw: string) => T | undefined, want: string): T => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = parse(raw);
    if (value === undefined) say(name, `${name}=${JSON.stringify(raw)} is not ${want}`);
    return value ?? fallback;
  };
  const string = (name: string, fallback: string) => read(name, fallback, (raw) => raw, 'a string');
  const integer = (name: string, fallback: number) => read(name, fallback, parseInteger, 'an integer');
  const number = (name: string, fallback: number) => read(name, fallback, parseNumber, 'a number');
  const duration = (name: string, fallback: number) => read(name, fallback, parseDuration, 'a duration such as "30s"');
  const check = (ok: boolean, name: string, problem: string) => {
    if (!ok) say(name, `${name} ${problem}`);
  };

  const engines = string('ENGINES', 'live');
  const config: Config = {
    port: integer('PORT', 24793),
    engines: engines === 'fake' ? 'fake' : 'live',
    live: {
      openRouterKey: env.OPENROUTER_API_KEY ?? '',
      parseModel: string('PARSE_MODEL', 'openai/gpt-6-luna'),
      parseEffort: string('PARSE_EFFORT', 'minimal'),
      parseBaseUrl: string('PARSE_BASE_URL', OPENROUTER_URL),
      recountModel: string('RECOUNT_MODEL', 'openai/gpt-6-luna'),
      recountEffort: string('RECOUNT_EFFORT', 'none'),
      recountBaseUrl: string('RECOUNT_BASE_URL', OPENROUTER_URL),
      jevModel: string('JEV_MODEL', 'typesafe/jev-1.13'),
      identifyCacheSize: integer('IDENTIFY_CACHE_SIZE', 10_000),
      modelTimeoutMs: duration('MODEL_TIMEOUT', 10_000),
      inputUsdPerMTok: number('INPUT_USD_PER_MTOK', 1),
    },
    maxBodyBytes: integer('MAX_BODY_BYTES', 8192),
    maxInputTokens: integer('MAX_INPUT_TOKENS', 256),
    guardMinConfidence: number('GUARD_MIN_CONFIDENCE', 0.5),
    judgeThreshold: number('JUDGE_THRESHOLD', 0.5),
    readAttempts: integer('READ_ATTEMPTS', 3),
    requestTimeoutMs: duration('REQUEST_TIMEOUT', 25_000),
    recountTimeoutMs: duration('RECOUNT_TIMEOUT', 10_000),
    promptsDir: string('PROMPTS_DIR', DEFAULT_PROMPTS_DIR),
  };

  check(config.port >= 1 && config.port <= 65535, 'PORT', 'must be between 1 and 65535');
  check(config.maxBodyBytes >= 1, 'MAX_BODY_BYTES', 'must be at least 1');
  check(config.maxInputTokens >= 1, 'MAX_INPUT_TOKENS', 'must be at least 1');
  check(isUnit(config.guardMinConfidence), 'GUARD_MIN_CONFIDENCE', 'must be between 0 and 1');
  check(isUnit(config.judgeThreshold), 'JUDGE_THRESHOLD', 'must be between 0 and 1');
  check(config.readAttempts >= 1, 'READ_ATTEMPTS', 'must be at least 1');
  check(config.live.inputUsdPerMTok >= 0, 'INPUT_USD_PER_MTOK', 'must be at least 0 (0 turns the estimate off)');
  check(config.live.identifyCacheSize >= 0, 'IDENTIFY_CACHE_SIZE', 'must be at least 0 (0 turns the cache off)');
  for (const [name, effort] of [
    ['PARSE_EFFORT', config.live.parseEffort],
    ['RECOUNT_EFFORT', config.live.recountEffort],
  ] as const) {
    check(EFFORTS.includes(effort), name, `is ${JSON.stringify(effort)}, want one of ${EFFORTS.join(', ')}`);
  }
  // a variable that failed its own check is not compared or told twice
  const bad = (name: string) => problems.some((p) => p.name === name);
  for (const [name, base] of [
    ['PARSE_BASE_URL', config.live.parseBaseUrl],
    ['RECOUNT_BASE_URL', config.live.recountBaseUrl],
  ] as const) {
    check(isHttpUrl(base), name, `is ${JSON.stringify(base)}, not an http(s) URL`);
    // with live engines the key goes along with every call: over http it would cross the network in the
    // clear, so http is for the local machine only
    if (!bad(name) && engines === 'live' && new URL(base).protocol === 'http:' && !isLocalhost(base)) {
      check(false, name, `is ${JSON.stringify(base)}, not https: a key is sent with it (http is for localhost only)`);
    }
  }
  check(config.live.modelTimeoutMs > 0, 'MODEL_TIMEOUT', 'must be positive');
  check(config.recountTimeoutMs > 0, 'RECOUNT_TIMEOUT', 'must be positive');
  check(config.requestTimeoutMs > 0, 'REQUEST_TIMEOUT', 'must be positive');
  // a call is bounded by the recount's time, which the request's time bounds in turn
  if (!bad('MODEL_TIMEOUT') && !bad('RECOUNT_TIMEOUT')) {
    check(config.recountTimeoutMs >= config.live.modelTimeoutMs, 'RECOUNT_TIMEOUT', 'must be at least MODEL_TIMEOUT');
  }
  if (!bad('RECOUNT_TIMEOUT') && !bad('REQUEST_TIMEOUT')) {
    check(config.requestTimeoutMs >= config.recountTimeoutMs, 'REQUEST_TIMEOUT', 'must be at least RECOUNT_TIMEOUT');
  }
  if (engines !== 'live' && engines !== 'fake') {
    say('ENGINES', `ENGINES is ${JSON.stringify(engines)}, want live or fake`);
  } else if (engines === 'live') {
    check(
      config.live.openRouterKey !== '',
      'OPENROUTER_API_KEY',
      'is required with ENGINES=live; set it, or run ENGINES=fake for the deterministic test engines',
    );
  }
  const langfuse = langfuseFromEnv(env, (line) => {
    say('LANGFUSE', line);
  });
  if (problems.length > 0) {
    // in the order of the configuration table, Langfuse last
    const rank = (name: string) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
    throw new ConfigurationError(problems.toSorted((a, b) => rank(a.name) - rank(b.name)).map((p) => p.line));
  }
  return { ...config, ...(langfuse && { langfuse }) };
}

/** The variables in the order of docs/architecture.md's configuration table: the order of the errors. */
const ORDER = [
  'PORT',
  'ENGINES',
  'OPENROUTER_API_KEY',
  'PARSE_MODEL',
  'PARSE_EFFORT',
  'PARSE_BASE_URL',
  'RECOUNT_MODEL',
  'RECOUNT_EFFORT',
  'RECOUNT_BASE_URL',
  'JEV_MODEL',
  'MAX_BODY_BYTES',
  'MAX_INPUT_TOKENS',
  'GUARD_MIN_CONFIDENCE',
  'JUDGE_THRESHOLD',
  'READ_ATTEMPTS',
  'IDENTIFY_CACHE_SIZE',
  'INPUT_USD_PER_MTOK',
  'MODEL_TIMEOUT',
  'RECOUNT_TIMEOUT',
  'REQUEST_TIMEOUT',
];

/** The reasoning efforts a reader may be asked; none sends no reasoning field. */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

function isHttpUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
}

/**
 * Whether the URL's host is the local machine, by exactly these names, as written (a URL parser
 * would lower-case the host and turn `127.1` into an address).
 */
function isLocalhost(raw: string): boolean {
  const host = /^[^:/?#]+:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^:/?#]*)/.exec(raw)?.[1] ?? '';
  const name = host.startsWith('[') ? host.slice(1, -1) : host;
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** Whether x is a probability, 0 to 1. */
function isUnit(x: number): boolean {
  return x >= 0 && x <= 1;
}

function parseInteger(raw: string): number | undefined {
  return /^[+-]?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
}

function parseNumber(raw: string): number | undefined {
  const x = Number(raw);
  return raw.trim() !== '' && !Number.isNaN(x) ? x : undefined;
}

const UNITS_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * A duration in whole milliseconds (a finer value is rounded): a number and a
 * unit, or several in a row: "30s", "1m30s", "1.5s", "500ms".
 */
export function parseDuration(raw: string): number | undefined {
  if (raw === '0') return 0;
  const match = /^([+-]?)((?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/u.exec(raw);
  if (!match?.[2]) return undefined;
  let ms = 0;
  for (const [, value, unit] of match[2].matchAll(/(\d+\.?\d*|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu)) {
    ms += Number(value) * (UNITS_MS[unit ?? ''] ?? Number.NaN);
  }
  // whole milliseconds: "1.1s" is 1100, not 1100.0000000000002,
  // which AbortSignal.timeout refuses
  ms = Math.round(ms);
  return Number.isFinite(ms) ? (match[1] === '-' ? -ms : ms) : undefined;
}
