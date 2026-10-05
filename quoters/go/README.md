# quoters/go: the Go implementation

The delorean API ([`api/openapi.yaml`](../../api/openapi.yaml)) in Go 1.26,
interchangeable with the TypeScript and Python implementations: the same
contract, the same pipeline, the same prompts (embedded from
[`prompts/`](../../prompts)), the same fake engines, the same bytes on the
wire. The end-to-end suite ([`e2e/`](../../e2e)) and the parity suite prove
it. [`docs/architecture.md`](../../docs/architecture.md) is the
specification; this file says how this implementation runs and why it is
built the way it is.

## Run

```sh
ENGINES=fake go run ./cmd/delorean            # :24791, deterministic fake engines, no key, no cost
OPENROUTER_API_KEY=… go run ./cmd/delorean    # :24791, the real models through OpenRouter
```

or, from the repository's root, `task go:run:fake` and `task go:run` (which
reads `OPENROUTER_API_KEY` and `LANGFUSE_*` from the root `.env`).

`delorean version` prints the version (set at build time, `-ldflags "-X
main.version=…"`), `delorean tokenizer` the size of the embedded
o200k_base vocabulary. `delorean healthcheck` asks the running service on this
machine for `/healthz` (the `PORT` it reads, 24791 by default, and nothing else):
exit code 0 and no output when it answers 200 with its health, else one line on
stderr and exit code 1. The image is distroless, with no shell or curl: this is
what a container's healthcheck runs.

```sh
curl -s localhost:24791/v1/quotes -d '{"cart": "Back to the Future 1\nBack to the Future 2\nLa chèvre"}'
```

In Docker, the image is built from the repository's root, for `prompts/`:

```sh
docker build -f quoters/go/Dockerfile -t delorean-go .   # or task go:docker
docker run -p 24791:24791 -e ENGINES=fake delorean-go
docker compose up --build quoter-go                      # with the root .env
```

## Test

```sh
go test -race ./...      # unit tests; no model is called without RUN_LIVE=1
golangci-lint run ./...  # task go:lint
go run ./cmd/bench check # the shared cases are valid (task cases:check)
task e2e                 # the end-to-end suite against this quoter on fake engines, :24799
task e2e:parity          # the three quoters against each other, byte for byte
```

The unit tests cover what decides: normalization and the token count (held
to tiktoken-go's counts, and timed on a 64 KB word), pricing, the pipeline on
the fake engines (each refusal, the stages it reports, the thresholds, the
reading again), the HTTP surface (every malformed body, the bytes written),
the live engines against stand-ins of OpenRouter and Jev (wire format, cost,
tokens, retries, the cache, kept-alive connections), the trace and its
propagation, and the configuration.

## Configure

The variables and defaults of
[docs/architecture.md](../../docs/architecture.md#configuration), read at
startup; every wrong one is reported at once, one line each, and the service
does not start. Beside them:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `24791` | HTTP listen port |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`, a URL) | — | traces and scores, when all are set; a half setting is a configuration error |
| `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE` | — | the traces' environment and release |

The prompts are compiled in (`prompts/` is a Go module that embeds them): no
directory to point at, and `/healthz` serves their versions.

## Layout

```
cmd/
  delorean/          entry: serve, healthcheck, version, tokenizer; configuration, tracing, engines, graceful shutdown
  bench/             the component benches: list, check, run, matrix, table
internal/
  config/            the environment, checked; errors in the table's order
  cart/              the vocabulary: films, mentions, lines
  prepare/           normalize, and the o200k_base token count (a heap-based BPE merge)
  pipeline/          the stages in order, reading again, their spans, usage and measures
  pricing/           integer cents, the catalog, the saga discount
  fake/              ENGINES=fake, the rules of docs/architecture.md
  decide/            Jev's client: typed questions, retries for benches, kept-alive connections
  live/              the real engines: guard, parse and recount, identify (and its cache), judge
  httpapi/           the contract served: generated routes and models, the body read strictly, problems
    ordered/         runs oapi-codegen with the contract's key order (x-order)
  telemetry/         the tracer (Langfuse through trpc-agent-go) and the scores
  bench/             subjects, matrix, dry run and reports of the component benches
bench/variants.yaml  the parser variants a matrix measures
```

## Choices

- **Contract first, generated.** `oapi-codegen` writes the routes and the
  models from `api/openapi.yaml` (`go generate ./...`); `ordered` hands it the
  contract with each property's rank, so the structs, and the JSON, keep the
  contract's key order, as the other quoters write it. Times are `Instant`:
  UTC with milliseconds.
- **The bytes every quoter writes.** One encoder for every answer: compact,
  no HTML escaping, U+2028 written as itself, no trailing newline, a
  `Content-Length` always. The body is read strictly, in the order the
  quoters share (`readCart`): UTF-8 first, then one JSON value, then the
  object and its one field, in words no parser's wording leaks into.
- **Errors are values of three kinds.** A `*pipeline.Rejection` is a refusal
  (422, with its facts and the usage so far); an error wrapping
  `pipeline.ErrEngine` is a model that failed, answered off contract or too
  late (502, cause logged, never shown); anything else is a bug (500). The
  request's deadline and the client's disconnect are its `context`.
- **A refused reading is read again** (docs/architecture.md, "read again"),
  up to `READ_ATTEMPTS` readings: nothing is identified twice, and a reading
  already judged keeps its Jev findings, so a wrong reading does not get
  three throws of Jev's dice.
- **The rules live in the pipeline, the engines only read.** The guard
  engines answer `order` and `steer`, `pipeline.Weigh` makes the verdict; the
  judge engines answer `asked`, `identity`, `missing`, the pipeline adds
  `count`. The fake and live engines cannot drift apart on a rule.
- **trpc-agent-go's model layer, called directly.** The readers use its
  OpenAI-compatible model (`openai.New`, `GenerateContent`) with OpenRouter's
  cost asked for and a strict `json_schema`; each call is our own generation
  span, whose answer is held to the schema before the span ends. Jev has no
  SDK: `decide` is a small client. No retry in the request path; benches
  wait out a rate limit (`Config.Attempts`).
- **Connections are kept alive**, one pool per engine (`decide.KeepAlive`): a
  quote's dozens of Jev calls reuse their TLS connections.
- **A title already identified is not asked again**: an in-memory LRU of
  `IDENTIFY_CACHE_SIZE` films, keyed by merge key, identify prompt version and
  `JEV_MODEL`; `cache_hits` on every identify span.
- **Tokens with tiktoken-go-loader's embedded o200k_base ranks, merged in a
  heap**: the counts are tiktoken's, in O(n log n) where the textbook merge
  is quadratic.
- **Langfuse through OpenTelemetry.** The service's own tracer provider
  (`service.name` `delorean`) carries trpc-agent-go's Langfuse exporter; a span
  processor gives every observation the trace's name, tags, user and session,
  as the Langfuse SDKs do. Scores go as one ingestion batch per quote, on a
  queue that never blocks a request.
- **Logs are `log/slog` JSON lines on stdout**, time in UTC with milliseconds,
  the fields and their order shared by the quoters.

## Benches

- **The component benches** (`cmd/bench`, `task bench -- run guard --runs
  1`): guard, identify, reading, judge and parse, played against the live
  engines on the shared `cases/`, with Langfuse datasets and experiments;
  `matrix` compares the parser variants of `bench/variants.yaml`, `--dry-run`
  prices a run before it spends, `--max-usd` stops one that would overspend,
  `table` rebuilds a matrix from its reports. Nothing is spent without
  `RUN_LIVE=1`. [`docs/testing.md`](../../docs/testing.md) has the details.
- **The system bench** (`e2e/`, `task bench:system -- --base-url
  http://localhost:24791`) runs the shared `cases/quote` against this quoter
  as against the others.
- **The parity suite** (`task e2e:parity`) compares the three quoters' bodies,
  logs and commands byte for byte on fake engines.
