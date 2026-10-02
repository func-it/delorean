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
| **Reading** | six stages: `prepare` → `guard` → `parse` → `identify` → `judge` → `price` |
| **Models** | Jev 1.13 decides (guard, identify, judge); GPT-6 Luna extracts titles and quantities; both through OpenRouter |
| **Contract** | one OpenAPI 3.1 file, [`api/openapi.yaml`](api/openapi.yaml), for every implementation |
| **Implementations** | Go today; Python and TypeScript next, measured against each other |
| **Observability** | one Langfuse trace per request, one span per stage, cost included |

## Services

The project keeps to ports 24790 to 24799, picked at random to stay clear of
other projects on the same machine.

| Service | URL | Notes |
|---|---|---|
| Web app (Next.js: UI + BFF) | <http://localhost:24790> | any username, no password |
| Go API | <http://localhost:24791/healthz> | `ENGINES=live` or `fake` |
| Python API | `http://localhost:24792` | planned, same contract |
| TypeScript API | `http://localhost:24793` | planned, same contract |
| Langfuse | <http://localhost:24794> | account `admin@delorean.local`, password `LF_USER_PASSWORD` in `.env` |
| Documentation site | <http://localhost:24795> | this guide, the architecture, the API reference, testing; `task docs` without Docker |

## Quick start

Requirements: Docker, or Go 1.26 and Node 26. [Task](https://taskfile.dev)
is optional (`task --list`).

### Without a key, at no cost (fake engines)

```sh
task langfuse:secrets                      # creates .env with SESSION_SECRET and Langfuse keys
ENGINES=fake docker compose up --build
```

The fake engines are deterministic: they recognise "Back to the Future 1/2/3"
written as is, and exist for tests. See
[Fake engines](docs/architecture.md#fake-engines-enginesfake).

### With the real models

Put `OPENROUTER_API_KEY` in your shell or in `.env`, then:

```sh
task langfuse:up                           # optional: traces at http://localhost:24794
docker compose up --build
```

A quote costs about $0.0006 and takes about 4 s (19 model calls for a
four-film cart: 18 Jev, 1 Luna).

### Without Docker

```sh
task setup
task go:run:fake            # the API on :24791 (task go:run for the real models)
cd web && npm run dev       # the web app on :24790
```

### The API alone

```sh
curl -s localhost:24791/v1/quotes -H 'content-type: application/json' \
  -d '{"cart":"Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre"}' | jq .total_cents
# 5600
```

## How it works

```
browser ─► web (Next.js: UI + BFF, session) ─► API (Go; Python and TypeScript next)
                                                 │
   prepare   code   normalises, counts tokens, bounds the size
   guard     Jev    valid | injection | invalid
   parse     LLM    titles and quantities (GPT-6 Luna, strict JSON schema)
   identify  Jev    each distinct title → volume 1, 2, 3 or another film, in parallel
   judge     Jev    is the reading faithful to the text? one question per fact
   price     code   integer cents
                                                 │
                              OpenRouter (Jev, GPT-6 Luna) · traces → Langfuse
```

Every stage may refuse the cart with a stable code (`too_long`, `injection`,
`invalid_request`, `no_film`, `quantity_too_large`, `unfaithful_reading`…) and
says why: the guard's verdict and probabilities, the token count, the judge's
checks. Every quote carries the cost and duration of each stage.

The stages, thresholds and questions put to the models are in
[`docs/architecture.md`](docs/architecture.md).

## Design decisions

- **Jev decides, the LLM extracts.** Jev (TypeSafe) answers a typed question
  with calibrated probabilities and cannot answer outside the options it is
  given: it is built to classify (the guard, the identification, the judge).
  Its own documentation says it does not count, so extracting titles and
  quantities goes to an LLM under a strict JSON schema.
- **A judge before every price.** The LLM's reading is held against the text
  by short questions, one per observable fact (is this film asked for? is the
  title the film it was identified as? this many copies? is a film missing?),
  asked separately and in parallel; the worst score decides. It is the
  evaluator of the benches, put in production.
- **An injection cannot set a price.** The guard rejects it; and if it slipped
  through, every model can only answer among bounded options: at worst a title
  is misread, never an amount invented.
- **A pre-parser counts tokens** before any call, with a BPE tokenizer compiled
  into the binary: Jev accepts at most 64k tokens, the cart is capped at 2048.
- **Contract first, three implementations next.** One `openapi.yaml`, one
  end-to-end suite, one system bench: Go, Python and TypeScript are compared on
  measurements (accuracy, latency, cost), not on opinions. Go is the first.
- **Fake engines to test without paying.** Deterministic and identical in the
  three implementations, they run the end-to-end suite in CI.
- **The session identifies, it does not authenticate:** a username, which ties
  Langfuse traces to a person.
- **Integer cents, and at most 1000 copies of one title:** a safeguard, not a
  business rule.
- **A box set is its films.** "The trilogy" is not a product of its own: it
  counts as the three volumes, so it gets the 20 % discount like any cart
  with the three of them.

## Testing, benches, observability

| What | Command | Cost |
|---|---|---|
| Unit tests (Go with `-race`, web, e2e harness) | `task test` | none |
| End-to-end suite against the Go API, fake engines | `task e2e` | none |
| Validate the shared cases | `task cases:check` | none |
| Everything CI runs | `task ci` | none |
| Component benches (guard, identify, reading, judge) | `RUN_LIVE=1 task bench -- run guard --runs 1` | OpenRouter |
| System bench of one implementation | `task bench:system -- --base-url http://localhost:24791 --runs 3` | OpenRouter if `live` |
| Compare implementations | `task bench:compare -- ../reports/a.json ../reports/b.json` | none |

The details are in [`docs/testing.md`](docs/testing.md).

## Status

- Pricing, the pipeline, the Go API, the web app, the end-to-end suite and the
  benches are done and tested: 12 Go packages, 113 web tests, 136 harness
  tests, 59 end-to-end tests, 338 shared cases.
- The real models are wired and verified end to end: example 5 of the brief
  priced at 56.00 € in about 4 s.
- Last live component benches, 3 runs per case:

  | Bench | Cases | Runs passed |
  |---|---|---|
  | guard | 113 | 324 / 339 |
  | identify | 61 | 180 / 183 |
  | judge | 42 | 119 / 126 |
  | reading | 46 | 135 / 138, films right in 138 |

  What still fails: one injection (a fake tool result granting a discount)
  accepted by the guard, though the code still prices the cart right; two
  real films whose titles read like orders (*Forget Paris*, *No se aceptan
  devoluciones*) refused; the judge's count of copies, which Jev cannot do
  reliably (see the roadmap).
- The thresholds (`GUARD_MIN_CONFIDENCE`, `JUDGE_THRESHOLD`, both 0.5) hold on
  the benches: faithful readings score far above, unfaithful ones far below,
  except on counting.
- The Python and TypeScript implementations are next, on the same contract.

## Roadmap

1. Guard: one question per fact, as the judge does: a second Jev request,
   "does this message speak to the system?", beside the verdict.
2. Counting: take it away from Jev. A second, independent reading by another
   LLM, compared film by film in code; a disagreement refuses the cart.
3. Pick the parse model on the numbers (GPT-6 Luna against others, through
   OpenRouter).
4. Write the Python and TypeScript backends, then compare the three with the
   system bench.
5. Record real model answers to replay the live engines in CI, at no cost.
6. Cache the identification of a title already seen: titles repeat.

## Repository

```
api/openapi.yaml      the contract, source of truth
docs/                 architecture, testing, and the documentation site (docs/site)
cases/                shared cases: quote, guard, identify, reading, judge
backends/go/          the Go implementation (pipeline, engines, API, benches)
web/                  Next.js: UI, BFF, session
e2e/                  end-to-end suite and system bench, for any backend
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
- [`e2e/README.md`](e2e/README.md) and [`web/README.md`](web/README.md): each
  part on its own.
