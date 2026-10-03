# delorean — the Python quoter

The HTTP API of [`api/openapi.yaml`](../../api/openapi.yaml) in Python 3.14.
It reads a free-text DVD cart and prices it with the Back to the Future
promotion. What it does is the same in the [Go](../go) and
[TypeScript](../typescript) quoters and lives in [`docs/`](../../docs):
[`architecture.md`](../../docs/architecture.md) holds the pipeline, the
prompts, the fake engines, the configuration and the rules that keep the three
indistinguishable ("Identical quoters"). This file says how the Python code
does it.

## Run

Everything goes through [uv](https://docs.astral.sh/uv/), which installs
Python 3.14 (`.python-version`) when the machine lacks it. From the
repository's root:

```sh
task py:setup        # uv sync --locked, and the tokenizer's vocabulary (once)
task py:run:fake     # on the fake engines, http://localhost:24792: no key, no cost
task py:run          # on the live engines: OPENROUTER_API_KEY and LANGFUSE_* from the root .env
task py:docker       # the image delorean-python:<git describe>, from the root
task e2e:python      # the end-to-end suite against it, on fake engines, port 24797
```

Without Task: `uv sync`, `uv run delorean tokenizer`, then
`ENGINES=fake uv run delorean serve`. The command line is
`delorean [serve | version | tokenizer]`.

## Test

`task py:test` runs about 390 tests in a few seconds and calls no model.

- **Ported from Go:** the prepare and pricing tests, case for case, with the
  same normal forms, token counts and cents.
- **Rules and pipeline:** every refusal at its stage, the attempts, the usage,
  and the trace's shape. Spans go to an in-memory exporter and scores to a
  stub ingestion API.
- **Fakes:** their rules, which are part of the test contract.
- **HTTP:** every body checked against the contract's JSON Schema, and byte
  for byte where the parity rules ask (compact, numbers, times). Also the
  malformed bodies in their order of checks, limits, ids, 404 and 405, and
  the log lines.
- **Contract:** `api/contract.py` is what `task py:generate` makes of the
  contract today.
- **Jev and the LLM readers:** against recorded answers on mock transports.
  The tests cover the wire format, what each question reads, the strict
  schema of a reading, the cost and tokens, and the errors. The assembly of
  what they send runs on a tiny prompt set (`tests/fixtures/prompts`), so no
  test copies the production wording. A test checks that none does.
- **The service:** a real process on the fake engines, its exact log lines,
  and SIGTERM.

`task py:lint` runs ruff (lint and format) and mypy `--strict`.

## Configure

The variables, defaults and checks are those of
[Configuration](../../docs/architecture.md#configuration). A wrong value stops
the quoter with every error at once, in the words every quoter uses
(`config.py`). Three variables are packaging, not behaviour:

| Variable | Default | Purpose |
|---|---|---|
| `PROMPTS_DIR` | the repository's `prompts/` | where the prompt files are read; only the JSON files, never the Go module beside them |
| `TIKTOKEN_CACHE_DIR` | `quoters/python/.tiktoken` | where the o200k_base vocabulary is. `delorean tokenizer` fetches it once, checked against its pinned SHA-256, and prints `o200k_base: 199998 ranks`. At startup a missing or altered file stops the quoter rather than being downloaded. The image fetches it at build time. |
| `DELOREAN_VERSION` | `dev` | the version `/healthz` and the traces report; the image and the tasks set `git describe` |

## Layout

```
src/delorean/
  __main__.py          the command line; serve wires settings, prompts, tokenizer, tracer, engines, app
  config.py            settings from the environment, every error at once
  cart.py              the vocabulary: Film, Mention, Line, the copy limit
  prepare.py           normalization, token counting, the vocabulary's fetch and check
  pricing.py           the catalog and the price, in integer cents
  prompts.py           prompts/*.json, checked at startup, versioned by their bytes
  telemetry.py         Tracer: NoTracer, or Langfuse (its SDK for spans, the ingestion API for scores)
  jsontext.py          JSON as every quoter writes it: compact, ECMAScript numbers, UTC milliseconds
  logs.py              one compact JSON line per event; the libraries' own lines silenced
  lru.py, tasks.py     the identification cache's map; calls side by side, the first failure cancelling the rest
  pipeline/
    ports.py           the engines' Protocols and what they answer; EngineError
    rules.py           the rules that decide, as plain functions: verdict, merge, count check…
    outcome.py         Quote, Rejection (with its code and facts), Report
    pipeline.py        the order of the stages, the attempts, the thresholds, the trace
  engines/
    fake.py            ENGINES=fake, the test contract's deterministic stand-ins
    live/jev.py        the Jev client: the decisions protocol, checks, cost, tokens
    live/questions.py  the guard, the identification (and its cache) and the judge on Jev
    live/reader.py     the parse and the recount: an LLM under a strict JSON schema
  api/
    contract.py        the contract's bodies, generated from api/openapi.yaml: task py:generate
    app.py             the routes and the handlers (FastAPI)
    body.py            the headers and the body, read in the order and words of every quoter
    answers.py         the pipeline's outcomes as the contract's bodies
    render.py          a body as the bytes every quoter sends
    problems.py        RFC 9457 problems, and what a request's log line needs
    middleware.py      request id, one log line per request, 500 for what nothing caught
tests/                 pytest; contract.py validates bodies against api/openapi.yaml
scripts/e2e-fake.sh    the end-to-end suite against this quoter on fake engines
```

## Choices

- **FastAPI routes; the contract answers.** FastAPI on uvicorn brings the
  routing, the exception handlers and the ASGI test client. It does not
  decide what an answer looks like:
  - its validation never runs: the handlers read their headers and body
    themselves (`api/body.py`), so no 422 of FastAPI's stands in for the
    contract's 400;
  - its slash redirects, its generated OpenAPI and its OpenTelemetry are off;
  - every body goes out through `api/render.py`.
- **Generated models.** datamodel-code-generator, pinned and configured in
  `pyproject.toml`, writes `api/contract.py`. Its pydantic models keep the
  contract's field order, which is the order the bodies are written in. The
  domain keeps its own enums (`Film`, `Stage`, `Check`, `Verdict`), and a test
  holds them equal to the contract's.
- **JSON written by hand, in one place.** Python's `json` writes `1.0` and
  `1e-07`, where every quoter writes `1` and `1e-7`. `jsontext.py` writes the
  bodies, the log lines and the trace outputs from the shortest `repr` digits
  of each number, following ECMAScript's rules.
- **A pure pipeline on Protocols.** The pipeline knows engines only as ports
  (`pipeline/ports.py`), and the rules that decide are plain functions
  (`pipeline/rules.py`). A refusal is a value (`Quote | Rejection`). An engine
  failure is an exception (`EngineError`, a 502) that names its stage; a bug
  is another (a 500).
- **Structured concurrency.** Each set of model calls runs in an `asyncio`
  TaskGroup, bounded to 16 in flight, and nothing outlives a request. The
  parse and the recount run side by side, and the parse decides first. Read
  again, a request keeps what it learnt (`_Memory`): a title is identified
  once, and a reading already judged is not put to Jev again.
- **One client per engine, for the whole process.** Jev, the parse and the
  recount each have their own client and connection pool, kept alive from one
  quote to the next.
- **Jev on httpx, the readers on the openai SDK.** Jev's decisions endpoint is
  not chat/completions, so a plain `httpx` client reaches it; its answers are
  parsed by a strict model and held to the questions asked. The parse and the
  recount use the official `openai` SDK with a strict `json_schema` response
  format and no client retries; their answers are validated again on return.
- **Traces.** The Langfuse SDK (v4, OpenTelemetry) runs on a `TracerProvider`
  of its own (`service.name=delorean`), so the global OpenTelemetry state is
  untouched.
  - The trace's metadata, input and output are set on the root span through
    OpenTelemetry, so numbers stay numbers.
  - Errors leave the SDK's block as normal exits, so a status message is the
    error's own message.
  - Scores go to the ingestion API from this module's own queue, so a failure
    is logged in the quoters' words.
- **Logs.** `logs.py` writes the parity log lines through the standard
  `logging` module. uvicorn's startup and shutdown lines and the SDKs' lines
  are silenced. The server's stop is logged by a uvicorn `Server` subclass
  that sees the signal.
- **Tooling.** uv with a committed `uv.lock` and direct dependencies pinned in
  `pyproject.toml`; ruff, mypy `--strict` with the pydantic plugin, pytest
  with pytest-asyncio.

## Benches

The system bench runs against this quoter like any other, from `e2e/`:
`task bench:system -- --base-url http://localhost:24792 --runs 3`. Live engines
need `RUN_LIVE=1` and spend OpenRouter credit. The component benches (`bench
list, check, run, matrix, table`, variants in `bench/variants.yaml`) are Go's
for now; the same command line here is planned, not started.
