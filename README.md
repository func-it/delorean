# Delorean

Price a DVD cart that the customer writes in free text.

A DVD shop sells the three *Back to the Future* films at 15 € each and every
other film at 20 €. Two different volumes in the cart take 10 % off every
Back to the Future DVD; three take 20 % off.

The customer writes the cart however they like: a list, a sentence, a story,
several languages, quantities in digits or in words. Delorean reads the text,
refuses what is not an order, and returns a detailed price.

**Models read, code counts.** No amount ever comes out of a model.

## At a glance

| | |
|---|---|
| **Input** | a cart in free text, `POST /v1/quotes {"cart": "…"}` |
| **Output** | a quote in integer cents, or a refusal with a stable code and the facts behind it |
| **Reading** | seven stages: `prepare` → `guard` → `parse` beside `recount` → `identify` → `judge` → `price` |
| **Models** | Jev 1.13 decides (guard, identify, judge); GPT-6 Luna extracts titles and quantities, and recounts them without reasoning; all through OpenRouter |
| **Contract** | one OpenAPI 3.1 file, [`api/openapi.yaml`](api/openapi.yaml), for every implementation |
| **Implementations** | Go, TypeScript on Node, and Python: interchangeable, same contract, same prompts, same end-to-end suite, measured against each other |
| **Observability** | one Langfuse trace per request, one span per stage, cost included |

## Services

The project keeps to ports 24790 to 24799, picked at random to stay clear of
other projects on the same machine.

| Service | URL | Notes |
|---|---|---|
| Web app (Next.js: UI + BFF) | <http://localhost:24790> | one page: write a cart, get the price; no login (`?quoter=python` picks another quoter) |
| Go API | <http://localhost:24791/healthz> | `ENGINES=live` or `fake` |
| Python API | <http://localhost:24792/healthz> | `ENGINES=live` or `fake` |
| TypeScript API | <http://localhost:24793/healthz> | `ENGINES=live` or `fake` |
| Langfuse | <http://localhost:24794> | account `admin@delorean.local`, password `LF_USER_PASSWORD` in `.env` |
| Documentation site | <http://localhost:24795> | this guide, the architecture, the API reference, testing; `task docs` without Docker |

## Quick start

Requirements: Docker, or Go 1.26, Node 26 and Python 3.14 with
[uv](https://docs.astral.sh/uv/). [Task](https://taskfile.dev) is optional
(`task --list`).

### Without a key, at no cost (fake engines)

```sh
task langfuse:secrets                      # creates .env with SESSION_SECRET and Langfuse keys
docker compose up --build                  # ENGINES=fake is the default
```

The fake engines are deterministic: they recognise "Back to the Future 1/2/3"
written as is, and exist for tests. See
[Fake engines](docs/architecture.md#fake-engines-enginesfake).

### With the real models

Put `OPENROUTER_API_KEY` in your shell or in `.env`, and a daily spending cap
(the web app does not start on live engines without one), then:

```sh
task langfuse:up                           # optional: traces at http://localhost:24794
ENGINES=live DAILY_BUDGET_USD=5 docker compose up --build
```

Each service is limited in memory and CPU, says when it is healthy (the web
app waits for the quoters; `delorean healthcheck` is the command inside the
quoters' images) and has 25 s to finish its requests when stopped.
The compose network's MTU follows the host's uplink (`DOCKER_NETWORK_MTU`,
1450 by default): left at Docker's 1500 on a host whose uplink is at 1450, a
TLS handshake to the models stalled for 3.6 s on about one cold connection in
two, which could outlast `MODEL_TIMEOUT` on the first quote after a start.

A four-film cart takes 17 model calls: 15 Jev (2 guard, 4 identify, 9
judge) and 2 LLM (the reading and the recount). Before the recount, when the
same cart took 18 Jev calls and 1 Luna, a quote cost about $0.0006 and took
about 4 s; it has not been measured since.

A public demo should cap what it can spend: `DAILY_BUDGET_USD=5` in `.env`
(absent or `0`: no cap) stops the web app from calling the quoters once the
quotes relayed that UTC day have cost that much, with a French message to the
visitor; the total survives restarts, in the `web-data` volume
([budget](web/README.md#daily-budget)).

### Without Docker

```sh
task setup
task go:run:fake            # the Go API on :24791 (task go:run for the real models)
task ts:run:fake            # the TypeScript API on :24793 (task ts:run)
task py:run:fake            # the Python API on :24792 (task py:run)
cd web && npm run dev       # the web app on :24790, which can call each of them
```

### The API alone

```sh
curl -s localhost:24791/v1/quotes -H 'content-type: application/json' \
  -d '{"cart":"Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre"}' | jq .total_cents
# 5600
```

## How it works

```
browser ─► web (Next.js: UI + BFF, session) ─► API (Go | TypeScript | Python)
                                                 │
   prepare   code      normalises, counts tokens, bounds the size
   guard     Jev       is it an order? does it speak to the system? → valid | injection | invalid
   parse     LLM       titles and quantities (GPT-6 Luna, strict JSON schema)    ┐ in parallel
   recount   LLM       the same reading, again (GPT-6 Luna, no reasoning)       ┘
   identify  Jev       each distinct title of both readings → volume 1, 2, 3 or another film
   judge     Jev+code  is the reading faithful to the text? do both readings count the same?
                       a refused reading is read again, told what failed: 3 readings at most
   price     code      integer cents
                                                 │
                     OpenRouter (Jev, GPT-6 Luna) · traces → Langfuse
```

Every stage may refuse the cart with a stable code (`too_long`, `injection`,
`invalid_request`, `no_film`, `quantity_too_large`, `unfaithful_reading`…) and
says why: the guard's verdict, its two answers and probabilities, the token
count, the judge's checks. Every quote carries the cost and duration of each
stage.

The stages and thresholds are in [`docs/architecture.md`](docs/architecture.md).
Every word put to a model is in [`prompts/`](prompts), shared by the
implementations: they are compared on their code, not on their prompts.

## Design decisions

- **Jev decides, the LLM extracts.** Jev (TypeSafe) answers a typed question
  with calibrated probabilities and cannot answer outside the options it is
  given: it is built to classify (the guard, the identification, the judge).
  Its own documentation says it does not count, so extracting titles and
  quantities goes to an LLM under a strict JSON schema.
- **A judge before every price.** The LLM's reading is held against the text
  by short questions, one per observable fact (is this film asked for? is the
  title the film it was identified as? is a film missing?), asked separately
  and in parallel; the worst score decides. It is the evaluator of the
  benches, put in production.
- **Two readings, compared in code.** Jev cannot count, so the cart is read a
  second time; the code compares both readings film by film, and any
  disagreement refuses the cart. The recount never sets the price. It is
  GPT-6 Luna again, without reasoning, chosen for its speed: it is the same
  model as the parse, so its readings are correlated. It catches a model
  that reads the same cart differently from one call to the next, not one
  that misreads it the same way twice. A second family (DeepSeek V4.1 Flash)
  was the more independent reader, but set a quote's p90 at 11 s.
- **The recount is a second opinion, not a dependency.** One that fails,
  answers off its schema or takes over `RECOUNT_TIMEOUT` (6 s) is asked once
  more if it failed fast, then left out: the quote goes on with the parse
  alone, held to the text by the judge, with no count check, and its usage
  says `degraded`. With nothing to count against, a cart whose lines all ask
  for one copy is priced, and one with a line of several copies is not:
  `503 quantity_unverified`, a refusal to retry, shown as one sentence. The first recount that succeeds is kept for the whole
  request. Every model call is bounded by `MODEL_TIMEOUT` (6 s), a request by
  `REQUEST_TIMEOUT` (15 s); the three must be ordered so.
- **A refused reading is read again, never re-judged as is.** A reading the
  judge refuses goes back to the model with what failed, up to three
  readings: a slip of the model should not cost the customer a refusal. Only
  a different reading goes back to Jev: judging the same one again would draw
  the lottery of a probabilistic judge until it said yes.
- **Three injections, then a pause.** The BFF, the only public entry, blocks
  a session or a username after 3 injection refusals in 15 minutes (an
  address after 10, for customers behind a shared one), keeps one quote in
  flight per key, and answers a text already refused at once.
- **One fact per question, the guard included.** The guard asks two things in
  two requests: does the message order films, does it speak to the system?
  The verdict is computed from both answers.
- **An injection cannot set a price.** The guard rejects it; and if it slipped
  through, every model can only answer among bounded options: at worst a title
  is misread, never an amount invented.
- **A pre-parser counts tokens** before any call, offline, with the same
  counts in the three implementations: Jev accepts at most 64k tokens, the
  cart is capped at 256 and the body at 8 KB (the longest text of the shared cases is 478 bytes). Its BPE merge is O(n log n): the textbook one is
  quadratic, and a 64 KB one-word body took 2 s of CPU before it was refused.
- **Contract first, three implementations.** One `openapi.yaml`, one
  `prompts/`, one end-to-end suite, one system bench: Go, TypeScript and
  Python are compared on measurements (accuracy, latency, cost), not on
  opinions. `/healthz` serves the prompt versions each one runs, and the suite
  fails a quoter that runs other prompts.
- **Fake engines to test without paying.** Deterministic and identical in the
  three implementations, they run the end-to-end suite in CI.
- **The session identifies, it does not authenticate:** no login, the first
  quote starts an anonymous session (`visiteur-1a2b3c4d`), which ties Langfuse
  traces to a visit and gives the strike rule and the budget something to count on.
- **Integer cents, and at most 1000 copies of one title:** a safeguard, not a
  business rule.
- **Three quoters, chosen for the people, not the runtime.** Waiting on
  models, Go, Node and Python serve the same load; models are over 99 % of a
  quote's cost. Go is cheapest to run, TypeScript shares the web app's
  language, Python owns the work on models (evals, fine-tuning, local
  models). See the [load bench](docs/testing.md#load-bench-the-three-images-no-model).
- **A box set is its films.** "The trilogy" is not a product of its own: it
  counts as the three volumes, so it gets the 20 % discount like any cart
  with the three of them.

## Testing, benches, observability

| What | Command | Cost |
|---|---|---|
| Unit tests (the three quoters, web, e2e harness) | `task test` | none |
| End-to-end suite against the three quoters, fake engines | `task e2e:all` (or `task e2e`, `e2e:typescript`, `e2e:python`) | none |
| The three quoters against each other, byte for byte | `task e2e:parity` | none |
| Load bench of the three images, fake engines that wait as models do | `task bench:load` | none |
| Validate the shared cases | `task cases:check` | none |
| Everything CI runs | `task ci` | none |
| Component benches (guard, identify, reading, judge) | `RUN_LIVE=1 task bench -- run guard --runs 1` | OpenRouter |
| System bench of one implementation | `task bench:system -- --base-url http://localhost:24791 --runs 3` | OpenRouter if `live` |
| Compare implementations | `task bench:compare -- ../reports/a.json ../reports/b.json` | none |

The details are in [`docs/testing.md`](docs/testing.md).

## Status

- The three quoters, the web app, the end-to-end suite and the benches are
  done and tested: Go (`-race`), TypeScript, Python (mypy strict), web, the
  e2e harness, and the end-to-end suite at 70 of 70 on each quoter; 341
  shared cases. `task ci` runs all of it, with no model called.
- The real models are verified end to end on the three quoters: example 5 of
  the brief priced at 56.00 € by each, for about $0.0006, in 3.3 to 5.9 s.
- Last live component benches (3 runs per case, $0.153):

  | Bench | Cases | Runs passed |
  |---|---|---|
  | guard | 113 | 324 / 339 |
  | identify | 61 | 180 / 183 |
  | judge | 42 | 126 / 126 |
  | reading | 46 | 133 / 138 |

  No run priced a cart wrong: every wrong reading was refused. The guard
  still lets a fake tool result through once in three, and refuses two real
  films whose titles read like orders; the reading, the judge and the code
  hold behind it.
- The parser was chosen on a matrix of ten models and settings ($0.30):
  GPT-6 Luna at effort `minimal`, 135 of 138 right, 1.2 s at p50, $0.08 per
  1,000 carts. Small and local models read under half of the carts right.
  The details are in [`docs/testing.md`](docs/testing.md).
- Under load, with the models' time simulated, the three quoters serve 200
  quotes in flight alike (57 req/s on one CPU); with CPU-bound work, Go
  spreads over four cores (56 req/s) while Node and Python stay on one (20):
  [Load bench](docs/testing.md#load-bench-the-three-images-no-model).
- Every quote is a Langfuse trace with its cost, latency, attempts and
  outcome as scores: `task langfuse:report` gives the mean, median and p90
  per quoter.

## Roadmap

1. Measure, live, the recount on GPT-6 Luna without reasoning: its latency,
   and the disagreements it still catches.
2. Compare the three quoters live with the system bench.
3. Measure the parse that also identifies (identify skipped), and the judge
   asked only when the two readings disagree.
4. Record real model answers to replay the live engines in CI, at no cost.

## Repository

```
api/openapi.yaml      the contract, source of truth
prompts/              every word put to a model, shared by the implementations
docs/                 architecture, testing, and the documentation site (docs/site)
cases/                shared cases: quote, guard, identify, reading, judge
quoters/go/           the Go implementation (pipeline, engines, API, component benches)
quoters/typescript/   the TypeScript implementation, on Node
quoters/python/       the Python implementation
web/                  Next.js: UI, BFF, session
e2e/                  end-to-end suite and system bench, for any quoter
deploy/langfuse/      self-hosted Langfuse, for traces and benches
deploy/docs/          the documentation site's web server (nginx)
scripts/              e2e-fake.sh, langfuse-secrets.sh, docs.sh
reports/              bench reports (not versioned by default)
```

## Further reading

- [`docs/architecture.md`](docs/architecture.md): the stages, thresholds,
  judge, fake engines, shared cases and configuration.
- [`docs/testing.md`](docs/testing.md): tests, cases, benches and their cost.
- [`api/openapi.yaml`](api/openapi.yaml): the HTTP contract.
- [`quoters/typescript/README.md`](quoters/typescript/README.md) and
  [`quoters/python/README.md`](quoters/python/README.md): each quoter's
  stack and choices.
- [`docs/site/quoters.html`](docs/site/quoters.html) (the Quoters page of
  `task docs`): the three quoters side by side, their code and key functions,
  and one request through each.
- [`e2e/README.md`](e2e/README.md) and [`web/README.md`](web/README.md): each
  part on its own.
