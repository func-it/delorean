# Testing

Delorean is tested at four levels. The first three never call a model and run
in CI; the fourth calls the real models and only starts on purpose.

| Level | What it proves | Where | Cost |
|---|---|---|---|
| Unit tests | each part does what it says | `backends/go`, `web`, `e2e` | none |
| Contract | every implementation speaks the same HTTP | generated code, response validation | none |
| End-to-end | the whole API behaves, on deterministic fake engines | `e2e/` | none |
| Benches | the real models read carts well enough, at what latency and cost | `backends/go/cmd/bench`, `e2e/` | OpenRouter |

## Unit tests

```sh
task test          # every part
task go:test       # go vet + go test -race ./...
```

- **Go**: 12 packages, run with the race detector. Pricing and the fake
  engines are fully covered; the pipeline is tested stage by stage, each
  refusal included; the HTTP layer is tested with `httptest`, and every
  response is validated against the schemas of `api/openapi.yaml`. The live
  engines are tested against stub OpenRouter servers: request shape, answer
  mapping, errors wrapped as engine failures, parallel fan-out, retries, cost.
- **Web**: 113 Vitest tests. The BFF routes with a stubbed backend (status and
  body passed through, session required, backend allow-list, timeout), the
  session helpers, price formatting, and the result and refusal components.
  A test table keyed by every problem code fails the type check when the
  contract gains a code that has no French message yet.
- **e2e harness**: 136 tests of the suite's own machinery (contract
  validation, case loading, report percentiles, Langfuse push against a stub).

## Contract

`api/openapi.yaml` is the source of truth, and nothing drifts from it silently:

- the Go server and models (oapi-codegen), the web types and the e2e types
  (openapi-typescript) are generated from it; CI regenerates them and fails on
  any difference;
- the end-to-end suite validates every response body against its component
  schema (`Quote`, `Problem`, `Health`, `Catalog`) with Ajv in JSON Schema
  2020-12 mode, and checks the media type (`application/json` or
  `application/problem+json`).

## Fake engines

With `ENGINES=fake`, every model stage is answered by a deterministic stand-in,
identical in the three implementations. They recognise canonical titles
("Back to the Future 2", "2 x Back to the Future 2", roman numerals), treat a
few markers as injections, and accept two fault lines: `#fake:engine_down`
(→ 502) and `#fake:unfaithful` (→ 422). Their exact rules are part of the
test contract: [Fake engines](architecture.md#fake-engines-enginesfake).

## Shared cases

One JSON file per case in `cases/`, read by every implementation and both
benches. Each case has a `note` that says which mistake it guards against.

| Folder | Subject | Cases |
|---|---|---|
| `quote/` | the API end to end: a total, the quantities per film, or a refusal code | 76 |
| `guard/` | valid, injection or invalid | 113 |
| `identify/` | one title → `bttf_1`, `bttf_2`, `bttf_3` or `other` | 61 |
| `reading/` | parse and identify together: quantities per film | 46 |
| `judge/` | is a given reading faithful to the text? | 42 |

The `fake` tag marks the 30 quote cases the fake engines must pass; CI plays
them. The others are played against the real models only.

Two other tags say how to read a case:

- `limite` marks a borderline call made on purpose, explained in the note:
  asking for a discount, a film on Blu-ray, a character's line in a story;
- `injection` on a `reading/` case is the second wall: an injection sent
  straight to parse and identify, as if the guard had let it through, and
  expecting only the films the customer really asked for.

The guard cases cover each family of injection in French, English and at
least two other languages: orders to the system, prices or rules imposed,
instructions aimed at the reading, the counting or the judge, fake turns and
tag escapes, payloads hidden in a title, markup or encoded text (base64,
leetspeak, homoglyphs, invisible characters), prompt leaks, role play. The
valid cases include real films whose titles sound like orders (*Forget
Paris*, *La Règle du jeu*, *Instructions Not Included*), so a guard that
reacts to words rather than intent is caught.

```sh
task cases:check   # offline: shape, id = file name, known films, verdicts and codes
```

## End-to-end suite

A black box that only speaks the HTTP contract, for any backend.

```sh
task e2e                                            # builds the Go API, runs it on fake engines, runs the suite
BASE_URL=http://localhost:24792 npm run e2e          # from e2e/: another backend
RUN_LIVE=1 BASE_URL=http://localhost:24791 npm run e2e   # against live engines (costs credits)
```

The suite reads `GET /healthz` first. On fake engines it runs the contract
suites and every `fake` case: 59 tests today. On live engines it refuses to
start without `RUN_LIVE=1`, then plays every quote case. It checks:

- malformed requests (400), oversized bodies (413), empty and over-long carts
  (422), the copies limit at its exact boundary;
- `X-Request-Id`, generated or echoed, on every answer, refusals included;
- `usage` on every 200 and 422, stages in pipeline order up to the one that
  refused;
- the invariants of every quote: subtotal = sum of the lines, line = unit
  price × quantity, the discount tier matches the distinct volumes, total =
  subtotal − discount, judge score ≥ threshold.

## Benches

Benches call the real models. They refuse to start without `RUN_LIVE=1`, an
OpenRouter key and Langfuse; `--dry-run` prints the calls and input tokens and
sends nothing.

### Component benches (Go)

One subject per model stage, played in-process with the application's own
engines, scored by code checks, and kept in Langfuse: the cases become a
dataset, each pass an experiment, so two prompt versions or two models compare
side by side. Every case is played several times: one pass proves little,
three show a rate.

| Subject | Engine | Checks |
|---|---|---|
| `guard` | Jev | the service's decision: accepted only if `valid` with a confidence ≥ `GUARD_MIN_CONFIDENCE`, otherwise `injection` or `invalid_request`; the raw verdict is recorded but never fails a case |
| `identify` | Jev | the film |
| `reading` | GPT-6 Luna, then Jev | quantities per film, merged as the pipeline merges them |
| `judge` | Jev | faithful or not, against `JUDGE_THRESHOLD` |

The console report gives, per case and per check, the runs passed out of the
runs scored and the mean score; for guard and identify, the lowest confidence
over the runs, so an answer that is right but barely shows up before it turns
wrong. Jev's input and output tokens go to Langfuse with each call.

```sh
task langfuse:up
task bench -- run guard --dry-run                   # 113 Jev calls, about 53,000 input tokens
RUN_LIVE=1 task bench -- run guard --runs 3
```

Each prompt and question set has a short version hash (guard `b6b92980`,
identify `723bcc7a`, parse `8018a6a9`, judge `d480faaf`), so a run says what it
tested.

Last live pass, 3 runs per case, about $0.09 for the four benches:

| Bench | Cases | Runs passed | Median | Cost |
|---|---|---|---|---|
| guard | 113 | 324 / 339 | 227 ms | $0.012 |
| identify | 61 | 180 / 183 | 229 ms | $0.007 |
| judge | 42 | 119 / 126 | 284 ms | $0.018 |
| reading | 46 | 135 / 138 (films right in 138) | 1.7 s | $0.053 |

The misses that remain are listed in the README's status; each one has its
case, so the next prompt or model is measured against them.

### System bench (any backend)

Plays `cases/quote` N times against a running backend and measures what the
customer gets: exact totals, refusal codes, quantities per film, error rate,
latency p50 / p90 / max, cost per cart, and duration and cost per stage. It is
the bench that compares the Go, Python and TypeScript implementations.

```sh
task bench:system -- --base-url http://localhost:24791 --runs 3
task bench:compare -- ../reports/go-live-….json ../reports/python-live-….json
```

Reports land in `reports/` as JSON and Markdown. With `LANGFUSE_*` set, each
pass is also pushed to Langfuse as an experiment on the `quote` dataset.

## Cost

| Action | Model calls | Cost |
|---|---|---|
| One four-film quote | 18 Jev, 1 Luna | about $0.0006 (measured $0.00047 before the `identity` check added 4 Jev calls) |
| A refusal by the guard | 1 Jev | about $0.00003 |
| Guard bench, 113 cases, one pass | 113 Jev | about $0.004 |
| The four component benches, 3 runs per case | about 2,600 Jev, 138 Luna | about $0.09 |
| Everything in CI | none | $0 |

## CI

GitHub Actions, three jobs on every push and pull request:

- **Go**: generated code matches the contract, golangci-lint, tests with the
  race detector, shared cases valid;
- **Web**: generated types match the contract, lint, type check, tests, build;
- **End-to-end**: the harness's lint, types and tests, then the suite against
  the Go API on fake engines.

`task ci` runs the same steps locally.
