# Quoter

The delorean API ([`api/openapi.yaml`](../api/openapi.yaml)) on Node 22.18 or later, or 26: the
pipeline, the prompts (read from [`prompts/`](../prompts)) and the fake
engines. The end-to-end suite ([`e2e/`](../e2e)) holds it to the contract,
and the system bench measures it on accuracy, latency and cost.
[`docs/architecture.md`](../docs/architecture.md) is the specification;
this file says how the quoter runs and why it is built the way it is.

## Run

```sh
npm ci
ENGINES=fake npm start         # :24793, deterministic fake engines, no key, no cost
OPENROUTER_API_KEY=… npm start # :24793, the real models through OpenRouter
```

or, from the repository's root, `task quoter:run:fake` and `task quoter:run` (which
reads `OPENROUTER_API_KEY` and `LANGFUSE_*` from the root `.env`).

`node src/main.ts version` prints the version, `node src/main.ts tokenizer`
the size of the bundled o200k_base vocabulary, and `node src/main.ts
healthcheck` asks the running service for `/healthz` (it reads `PORT`, nothing
else): exit 0 and no output when it is up, exit 1 and one line on stderr
otherwise. It is what compose's healthcheck runs in the image.

There is no build step: Node runs the TypeScript sources as they are (type
stripping), and `tsc` only checks them.

```sh
curl -s localhost:24793/v1/quotes -d '{"cart": "Back to the Future 1\nBack to the Future 2\nLa chèvre"}'
```

In Docker, the image is built from the repository's root, for `prompts/`:

```sh
docker build -f quoter/Dockerfile -t delorean-quoter .   # or task quoter:docker
docker run -p 24793:24793 -e ENGINES=fake delorean-quoter
docker compose up --build quoter                              # with the root .env
```

## Test

```sh
npm test                 # unit tests (Vitest); no model is ever called
npm run lint             # ESLint, typescript-eslint strict type-checked
npm run typecheck        # tsc, strict
npm run format:check     # Prettier
task e2e                 # the end-to-end suite against this quoter on fake engines, :24799
```

The unit tests cover what decides: normalization and token counts, pricing, the pipeline on the fake engines (refusal codes, the
stages each refusal reports, the guard and judge thresholds, the parse beside
the recount), the fake engines' rules (the brief's format, one title per line, and `demo_unreadable` for a line they cannot read), the HTTP surface, and the live engines
against stand-ins of OpenRouter (Jev's wire format, retries, cost and tokens;
the readers' request, schema checks and cost), the trace shape, and the
configuration.

## Configure

The variables and defaults of
[docs/architecture.md](../docs/architecture.md#configuration), all read at
startup; every wrong one is reported at once, and the service does not start.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `24793` | HTTP listen port |
| `ENGINES` | `live` | `live` or `fake` |
| `OPENROUTER_API_KEY` | — | required with `live` |
| `PARSE_MODEL`, `PARSE_EFFORT` | `openai/gpt-6-luna`, `minimal` | the parsing LLM; effort `none` (no reasoning field), `minimal`, `low`, `medium`, `high` |
| `PARSE_BASE_URL`, `RECOUNT_BASE_URL` | `https://openrouter.ai/api/v1` | each reader's OpenAI-compatible API (Ollama: `http://localhost:11434/v1`); with `ENGINES=live`, where a key goes along with every call, http is refused but for localhost, 127.0.0.1 and ::1 |
| `RECOUNT_MODEL`, `RECOUNT_EFFORT` | `openai/gpt-6-luna`, `none` | the recounting LLM: the parser's model without reasoning, for speed; another family can be set |
| `JEV_MODEL` | `typesafe/jev-1.13` | Jev, pinned |
| `MAX_BODY_BYTES` | `8192` | largest body (413 above) |
| `MAX_INPUT_TOKENS` | `256` | largest cart, in o200k_base tokens (422 `too_long` above) |
| `GUARD_MIN_CONFIDENCE` | `0.5` | least confidence of a `valid` verdict |
| `JUDGE_THRESHOLD` | `0.5` | lowest judge score priced |
| `IDENTIFY_CACHE_SIZE` | `10000` | titles whose film is kept in memory across requests (LRU, keyed by merge key, identify version and `JEV_MODEL`); 0 turns it off |
| `READ_ATTEMPTS` | `3` | most readings of one cart, told what failed, before `unfaithful_reading` |
| `INPUT_USD_PER_MTOK` | `1` | USD per million input tokens a parse or recount call that ends without the cost OpenRouter bills (timeout, abort, failure after it was sent) is counted for in `usage`: an estimate (tokens of what it sent × this), a conservative upper bound so that the daily budget does not take it for free; `0` counts nothing |
| `MODEL_TIMEOUT` | `10s` | most one model call may take, Jev's and the LLMs' (502 past it, or the recount degraded); whole milliseconds, and `MODEL_TIMEOUT` ≤ `RECOUNT_TIMEOUT` ≤ `REQUEST_TIMEOUT`, or the service does not start |
| `RECOUNT_TIMEOUT` | `10s` | the recount's time, a retry included, before the quote goes on without it |
| `REQUEST_TIMEOUT` | `25s` | budget of one request, model calls included (the web app waits this plus 5 s, compose lets the container stop for 35 s); durations are a number and a unit (`1m30s`, `500ms`) |
| `LOG_CARTS` | `false` | `true`, `false`, `1` or `0`: the request's log line of a quote says `outcome` (`priced` or the refusal's code), `total_cents`, `readings`, `cost_usd` and `stage_ms` (the milliseconds of each stage); with `true` it also carries `cart`, the text as the pipeline sees it, cut to 500 characters (`cart_truncated`). The cart is the customer's free text and may hold personal data (GDPR): leave it off unless you need to see what was played, and tell the visitors if you turn it on in public; how long the lines live is the log driver's setting, not the service's |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`, a URL) | — | traces and scores, when all are set; a half setting is a configuration error |
| `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE` | — | the traces' environment and release |
| `PROMPTS_DIR` | the repository's `prompts/` | where the shared prompts are read, at startup; their versions are in `/healthz`; `/app/prompts` in the image |
| `DELOREAN_VERSION` | `dev` | the version `/healthz` reports; the image and the tasks set it from `git describe` |

## Layout

```
src/
  main.ts                 entry: configuration, tracing, engines, server, graceful shutdown
  config.ts               the environment, checked
  cart.ts  text.ts        the vocabulary (films, mentions, lines); titles compared by their lower-cased words
  prompts.ts              prompts/*.json read, checked and versioned (sha256, 8 hex digits, in /healthz)
  prepare/                normalize (NFC, invisible characters), TokenCounter (o200k_base)
  pricing.ts              integer cents, the catalog, the saga discount
  pipeline/
    ports.ts              the engines' interfaces, EngineError
    pipeline.ts           the stages, in order, their spans and their usage
    reading.ts            the rules on what engines answer: verdict, merge, copies, identification, count
    rejection.ts          Rejection: a refusal, its code, its facts, its report
  engines/
    fake.ts               ENGINES=fake, the rules of docs/architecture.md
    live/                 Jev (jev.ts, questions.ts) and the LLM readers (reader.ts), on OpenRouter
  http/                   Hono app: routes, problems, the body read strictly (body.ts, json.ts), contract mapping
  telemetry/              Langfuse export (langfuse.ts) and spans (trace.ts)
  generated/openapi.ts    the contract's types (npm run generate)
test/                     Vitest
scripts/e2e-fake.sh       the end-to-end suite against this quoter on fake engines
```

## Choices

- **Node 22.18+ or 26, TypeScript strict, ESM, no build step.** Node strips the types
  and runs `src/` as written; `tsconfig.json` (`erasableSyntaxOnly`,
  `verbatimModuleSyntax`) keeps the code to what stripping allows. What runs
  is what you read, in development, in tests and in the image.
- **Hono on `@hono/node-server`** for HTTP. Small, typed, built on the web
  standard `Request`/`Response`, so the app is tested in-process
  (`app.request()`) without a socket, and the client's disconnect reaches the
  pipeline as an `AbortSignal`. Express has no types of its own nor a fetch
  API; Fastify's plugins and schemas would duplicate what the contract and
  the code already say.
- **Errors are values of three kinds.** A `Rejection` is a refusal (422, with
  its facts and the usage so far); an `EngineError` is a model that failed,
  answered off contract or too late (502, cause logged, never shown);
  anything else is a bug (500). The recount is the exception, a second
  opinion: one that fails, answers off its schema or outlasts
  `RECOUNT_TIMEOUT` (asked once more when it failed in under half of it)
  does not fail the quote, which goes on with the parse alone, no count
  check, its stage `degraded` in the usage, a warning in the trace and
  `degraded=recount` on the request's log line. Only an `EngineError`
  degrades it; a bug fails the quote like any stage's. The request's
  deadline and the client's disconnect are one `AbortSignal`, passed to every
  engine call.
- **A refused reading is read again** (docs/architecture.md, "read again"),
  up to `READ_ATTEMPTS` readings: the parser is told its last reading and
  the checks that failed, the recount stays blind, and the first one that
  succeeded is kept for the request. Nothing is asked twice in
  a request: `Identifications` keeps each title's film, and a reading
  already judged (`readingKey`: titles, quantities and films, in any order)
  keeps its Jev findings, only its count checks made anew, so a wrong
  reading does not get three throws of Jev's dice. Usage adds up stage by
  stage; each stage's span carries its attempt.
- **The rules live in the pipeline, the engines only read.** The guard
  engines answer `order` and `steer`; the pipeline makes the verdict. The
  judge engines answer `asked`, `identity`, `missing`; the pipeline adds
  `count`. So the fake and live engines cannot drift apart on a rule.
- **Connections are kept alive**, one undici `Agent` per engine (Jev, the
  parse, the recount): a quote's dozens of Jev calls reuse their TLS connections.
- **A title already identified is not asked again** (`engines/live/cache.ts`):
  an in-memory LRU of `IDENTIFY_CACHE_SIZE` films, keyed by merge key,
  identify prompt version and `JEV_MODEL`; hits make no call and show as
  `cache_hits` on the identify span; errors and off-contract answers are not
  kept. The fakes are not cached: they cost nothing, and their one call per
  stage is part of the test contract.
- **Jev through `fetch`.** It has no SDK; its client is small: the wire
  format, answers checked against their questions, cost and tokens
  under either spelling, at most 16 requests in flight, the first failure
  stops the rest. It can wait out a 429/5xx (`attempts`), but the server does
  not: a customer waits, and a failure is a 502 at once.
- **The LLM readers through the official `openai` SDK**, pointed at
  OpenRouter: strict `json_schema` output, `usage: {include: true}` for the
  cost, no retry. The answer is checked against the schema (Ajv), never
  trusted.
- **Tokens with js-tiktoken's o200k_base ranks, merged in a heap.** The
  counts are tiktoken's (a test holds them to js-tiktoken on random text),
  but tiktoken's merge rescans a piece after each merge: quadratic, so one
  64 KB word under the body limit would hold Node's single thread for
  minutes. The heap merges the same pairs in the same order in milliseconds.
- **Langfuse, as docs/architecture.md says it** ("Usage, cost and traces",
  "Conventions of the answers"): the spans through its OpenTelemetry SDK
  (`@langfuse/tracing`, `@langfuse/otel`, the resource naming the service
  `delorean`), opened by the HTTP layer once the body decodes, the trace's
  attributes propagated to every observation; the scores as one ingestion
  batch per quote, posted with `fetch`, at most 256 on their way. The SDK's
  logger is silenced: what fails is said by ours. Without `LANGFUSE_*`
  nothing is registered and every span is a no-op.
- **The body is read in a fixed order of checks** (`http/body.ts`,
  `http/json.ts`): a small scan of the first JSON value tells a truncated
  body from an invalid one and from data after it, in words no parser's
  wording leaks into; `JSON.parse` then reads the value.
- **Logs are JSON lines on stdout** (`log.ts`), in the fields and order
  docs/architecture.md gives; no logger dependency for that.
- **Dependencies are few**: hono, @hono/node-server, undici, openai, ajv,
  js-tiktoken, @langfuse/core, @langfuse/tracing, @langfuse/otel and
  @opentelemetry's api, resources and sdk-trace-node; pinned by
  `package-lock.json`, as in `web/` and `e2e/`.

## Benches

- **The system bench** (`e2e/`, `task bench -- --base-url
  http://localhost:24793`) runs the shared `cases/quote` against this quoter and
  measures accuracy, latency and cost.
- **The stage benches** (`bench/`, `task bench:stage -- list`, or
  `npm run bench:stage -- list`) play each stage alone (guard, identify, parse,
  reading, judge) on this quoter's own engines, against the `cases/<stage>/`
  folders, and compare parser variants (`bench/variants.yaml`).
  `check` reads the cases offline; `run <subject> --dry-run` counts the calls
  and tokens before anything is sent; a live run needs `RUN_LIVE=1` and an
  OpenRouter key, and `--max-usd` caps it. The commands, the reports and the
  results are in [`docs/testing.md`](../docs/testing.md#stage-benches).

One thing JavaScript cannot do: a quantity past 2^53 loses
precision instead of saturating. Such a cart is refused as
`quantity_too_large` all the same, with an approximate count.
