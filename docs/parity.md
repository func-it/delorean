# Parity of the three quoters

The Go, TypeScript and Python quoters must be indistinguishable from the
outside: same HTTP bytes, same logs, same configuration, same traces, same
commands. This file is the audit of 2026-10-03, run on the fake engines
(`ENGINES=fake`) with the code read alongside, and the decision taken on each
difference. The decisions are the rules of
[Identical quoters](architecture.md#identical-quoters); `task e2e:parity`
enforces those that can be observed from outside a process.

A decision is the best behaviour, not Go's by default. **Fix** names the
quoters that change.

## HTTP

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| Statuses, 34 probes (quotes, 400s, 404, 405, 413, 422, 502) | same | same | same | — | — |
| `Content-Type` | `application/json`, `application/problem+json`, no charset | same | same | — | — |
| `Allow` on 405 | `POST`; `GET, HEAD` | same | same | — | — |
| Body key order | alphabetical (oapi-codegen) | contract order, except `judge.attempts` last, `limits.max_reading_attempts` last, `request_id` last in a problem, and `Health` | contract order, except `Health` | the contract's declaration order. The contract changes twice to match its own examples: `Health` lists `status, implementation, version, engines, tracing, prompts`, as its `required`; `Problem` lists `code` before `detail`. A map's keys (`probabilities`) are sorted, as all three already do | Go, TS, Py (`Health`) |
| Number format | `1`, `0` | `1`, `0` | `1.0`, `0.0` | ECMAScript's (`JSON.stringify`): no `.0`, exponents as `1e-7` | Py |
| Trailing newline | `\n` after the body | none | none | none | Go |
| `created_at` | UTC, µs: `…22.874489Z` | UTC, ms: `…22.946Z` | UTC, µs | UTC, milliseconds, `Z`: `2026-10-03T13:10:22.946Z` | Go, Py |
| Generated `X-Request-Id` | 26 base32 characters `[A-Z2-7]` | UUID v4 | 26 base32 | 26 base32 characters, 128 random bits | TS |
| Given `X-Request-Id` | echoed | echoed | echoed | — | — |
| Quote id | `q_` + 16 `[a-z2-7]` | same | same | — | — |
| `healthz.version` | `dev` | `dev` | `1.0.0` (package) | `dev` unless the build sets it | Py |
| Syntax error detail | `body: invalid JSON at byte 2: invalid character 'c' looking for…` | `body: invalid JSON: Expected property name or '}' in JSON at position 1…` | `body: invalid JSON: key must be a string at line 1 column 2` | `body: invalid JSON`: no parser's wording, which no two runtimes share | Go, TS, Py |
| Truncated body | `body: truncated JSON` | `body: invalid JSON: Unexpected end of JSON input` | `body: truncated JSON` | `body: truncated JSON` | TS |
| Data after the object | `body: unexpected data after the QuoteRequest object` | `body: invalid JSON: Unexpected non-whitespace character…` | as Go | as Go | TS |
| `{"cart": null}` | `body: field "cart" is required` | as Go | `…must be a string, not a JSON null` | `body: field "cart" must be a string, not a JSON null`: the field is there | Go, TS |
| `{"cart": true}` | `…not a JSON bool` | `…not a JSON boolean` | `…not a JSON boolean` | `boolean`, JSON's word | Go |
| Invalid UTF-8 | `body: not valid UTF-8` | same | `body: invalid JSON: invalid unicode code point…` | `body: not valid UTF-8`, checked before the JSON | Py |
| Header given twice | `Expected one value for X-User-Id, got 2` | joins them, then `header X-User-Id: must match …` | `header X-User-Id: expected one value, got 2` | `header <Name>: expected one value, got <n>`, for the three headers | Go, TS |
| Trailing slash `/v1/catalog/` | 404 | 404 | 307 redirect | 404, like any unknown path | Py |
| Other 400, 404, 405, 413, 422, 502 problems | same bytes once ordered | same | same | — | — |
| `Connection`, `Keep-Alive`, `Date`, header case and order | Go's server | Node adds `Keep-Alive: timeout=60` | uvicorn | transport, not compared | — |

## Logs

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| Format | JSON lines, compact | same | JSON with spaces after `:` and `,` | compact JSON, keys `time, level, msg`, then the fields | Py |
| `time` | local offset, µs: `08:08:51.972471-05:00` | UTC, ms, `Z` | UTC, ms, `+00:00` | UTC, ms, `Z`, as `created_at` | Go, Py |
| Startup lines | `listening`, then the fake `WARN` | `WARN`, then `listening` | `listening`, `WARN`, then 4 uvicorn lines | the fake `WARN` (when fake), then `listening`; nothing else | Go, Py |
| `listening` fields | `addr, version, engines, tracing` | `+ prompts` | `port` instead of `addr`; `prompts` with `recount` and `parse-films` | `addr` (`:24791`), `version`, `engines`, `tracing`, `prompts` as `/healthz` serves them | Go, Py |
| Request line | `request_id, method, path, status, ms, bytes[, code][, err]` | no `bytes` | as Go | as Go; `ERROR` for a 5xx, `INFO` otherwise | TS |
| `err` of a fake engine down | `parse: fake reading: engine unavailable: #fake:engine_down` | `parse: fake parse: #fake:engine_down` | `fake reader: #fake:engine_down` | `<stage>: <cause>`; a fake's cause is `fake engine unavailable (#fake:engine_down)` | Go, TS, Py |
| Shutdown | `shutting down` | `shutting down`, `signal` | uvicorn's 4 lines (`Shutting down`…) | `INFO shutting down` with `signal`, exit 0 | Go, Py |
| Telemetry warnings | `langfuse scores not sent`, `…dropped, the queue is full`, `traces not flushed`, `scores not flushed` | `traces not flushed`; the SDK's own text otherwise | none; the SDK's own text | `WARN` lines with Go's messages, the SDK loggers silenced or routed to ours | TS, Py |

## Configuration

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| Variables and defaults | same | same | same | — | — |
| Error output | `delorean: configuration:` then one line per variable, exit 1 | same | same layout | — | — |
| Wording | `ENGINES is "foo", want live or fake`, `PARSE_EFFORT is "max", want one of none, minimal, low, medium, high`, `IDENTIFY_CACHE_SIZE must be at least 0 (0 turns the cache off)`, `PARSE_BASE_URL is "ftp://x", not an http(s) URL` | as Go | `ENGINES='foo' is not live or fake`, `…is not none, minimal, low, medium or high`, `…must be 0 or more`, `…must be a URL`; values in `'…'` | Go's wording, values in `"…"` | Py |
| Invalid `ENGINES` | one line | one line | adds the `OPENROUTER_API_KEY` line | one line per wrong variable | Py |
| Langfuse half set | `delorean: telemetry: langfuse: LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL or LANGFUSE_HOST missing` | `delorean: langfuse: …` | in the configuration block, `…: Langfuse is half configured` | in the configuration block: `Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing` | Go, TS, Py |
| `LANGFUSE_HOST` | `host:port`; `LANGFUSE_INSECURE` for plain HTTP | the SDK's: a URL | the SDK's: a URL | a URL, as the Langfuse SDKs read it; the scheme says HTTP or HTTPS; `LANGFUSE_INSECURE` goes | Go |
| `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE` | ignored | honoured by the SDK | honoured by the SDK | honoured | Go |
| Default `PORT` | 24791 | 24793 | 24792 | kept: one port each, to run them side by side | — |
| `PROMPTS_DIR`, `DELOREAN_VERSION`, `TIKTOKEN_CACHE_DIR` | embedded, `-ldflags` | read | read | packaging, not behaviour: kept | — |

## Commands

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| `delorean` / `serve` / `version` | yes | yes | yes | — | — |
| `tokenizer` | no | no | caches the vocabulary, prints its path | every quoter: makes the vocabulary available offline, prints `o200k_base: <n> ranks` | Go, TS, Py |
| Unknown command | `delorean: unknown command "x": want serve or version`, exit 1 | same | `…'x': want serve, version or tokenizer`, exit 2 | `delorean: unknown command "x": want serve, version or tokenizer`, exit 2 (a usage error) | Go, TS, Py |
| Extra argument | ignored | ignored | ignored | `delorean: unexpected argument "x"`, exit 2 | Go, TS, Py |
| Taskfile | `generate, lint, test, run, run:fake, build, docker` | `setup, generate, lint, test, run, run:fake, docker` | `setup, tokenizer, lint, format, test, run, run:fake, docker` | `setup, generate, lint, format, test, run, run:fake, docker` (and `bench` once ported); Python generates its contract models; `tokenizer` becomes internal to `setup` | Go, TS, Py |

## Docker

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| Build context | the repository's root | same | same | — | — |
| User | `nonroot` (65532) | `node` (1000) | `delorean` (10001) | numeric `65532:65532` | TS, Py |
| Entry point | `ENTRYPOINT delorean`, `CMD serve` | `CMD node src/main.ts` | as Go | `ENTRYPOINT` the program, `CMD ["serve"]`: `docker run <image> version` works | TS |
| `ENV` | `PORT`, `ENGINES=live` | `+ NODE_ENV, PROMPTS_DIR, DELOREAN_VERSION` | `+ PROMPTS_DIR, TIKTOKEN_CACHE_DIR, DELOREAN_VERSION` | packaging: kept | — |
| `EXPOSE` | its port | its port | its port | — | — |
| `HEALTHCHECK` | none | none | none | none: the Go image has no shell, compose needs none | — |

## Traces (Langfuse)

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| Root `quote`, type `agent`, stage names and types, `attempt` metadata, `chat <model>` and `decide <jev>` generations, usage `{input, output}`, cost `{total}`, scores | same | same | same | — | — |
| User, session, trace name, tags | `langfuse.user.id`, `langfuse.session.id`, root only | `user.id`, `session.id`, trace name on every span, tags root only | all on every span | the SDK keys (`user.id`, `session.id`, `langfuse.trace.name`, `langfuse.trace.tags`) on every observation | Go, TS |
| Trace metadata | numbers for `attempts`, `total_cents` | numbers | strings; `prompts` on every span; its `parse` ignores `PARSE_IDENTIFIES` | on the root only; `attempts` and `total_cents` numbers; `prompts` as `/healthz` serves them | Py |
| Input | the cart after prepare, set after prepare | the cart, set at the start | root observation only | the cart as received, on the trace and the root, at the start | Go, Py |
| Output | the body, trace and root | same | root only | the body, trace and root | Py |
| Environment, release | never | from `LANGFUSE_*` | from `LANGFUSE_*` | from `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE` | Go |
| Resource | `service.name=telemetry` (trpc's) | `unknown_service:node` | `unknown_service` | `service.name=delorean`, `service.version=<version>` | Go, TS, Py |
| guard output | `{"Verdict","Confidence","Probabilities","Questions"}` | `{verdict, confidence, probabilities, questions}` | `answers` for `questions` | the contract's `GuardOutcome` | Go, Py |
| judge output | PascalCase, `Attempts: 0` | `{score, findings, attempts}` | `attempts: 1` always | `{score, findings: [{check, label, score}], attempts: <reading>}` | Go, Py |
| identify output | `{reading, recount}` | `+ asked` | `{reading, recount}` | `{reading, recount}` | TS |
| parse output on a refusal | `{code, detail}` for `quantity_too_large` | the reading | `{code, detail}` for `no_film`, `quantity_too_large` | the reading as read; the refusal is the quote's, on the root | Go, Py |
| A mention without a film | omitted | omitted | `"film": null` | omitted | Py |
| `cache_hits` | when > 0 | always | when > 0 | always, when the cache is on | Go, Py |
| Off-schema answer | stage ERROR, generation not | generation ERROR | generation ERROR | the generation ERROR too | Go |
| Usage of a failed call | zeros written | not set | not set | set only from a response that reports it | Go |
| `model.parameters` | none | `{"reasoning_effort": …}` | none | `{"reasoning_effort": …}`, `none` included | Go, Py |
| Retries of a model call | none in the request path (`Config.Attempts` is the benches') | none | none | none: reading again is the only retry, and it is visible | — |
| Jev generation | adds `gen_ai.*`; output drops empty fields | as decoded | input with spaces, insertion order | input compact with sorted keys; output as decoded; no `gen_ai.*` | Go, Py |
| Error status message | the error's message | same | `"<Type>: <message>"`; cancellation counts as a failure | the message (a stage its engine's, the root `<stage>: <cause>`), an exception event; a cancelled request is not an error | Py |
| Strings in trace JSON | `\u003c` for `<` (encoding/json) | as written | as written | as the bodies (JSON.stringify) | Go |
| Score transport | ingestion batch, event id = score id, µs timestamp | SDK, random event ids | SDK, random event ids | one ingestion batch per quote; event id = score id; timestamp UTC ms | Go (timestamp), TS, Py (event id) |

## Documentation and benches

| Aspect | Go | TypeScript | Python | Decision | Fix |
|---|---|---|---|---|---|
| README | none | `Run, Test, Configure, Layout, Choices, Where it differs from Go` | same, other titles | `quoters/<name>/README.md`: `Run, Test, Configure, Layout, Choices, Benches`; behaviour lives in `docs/`, a README only says how the code does it | Go, TS, Py |
| Component benches | `bench list, check, run, matrix, table` | none | none | the same CLI in each, `bench/variants.yaml` at the root: a plan, not started | — |

## How it holds

| What | Held by |
|---|---|
| HTTP status, headers, body bytes; key order; number and time formats; log lines; commands, configuration errors, startup and shutdown | `task e2e:parity` (`e2e/parity/`): the three quoters on fake engines, every probe and every shared quote case, compared after the generated ids, times and durations are replaced by placeholders |
| Task names, README sections, image user and entry point | `e2e/test/parity-files.test.ts`, in `task test` |
| Traces and scores | `task e2e:parity` (`e2e/parity/traces.parity.ts`): the quoters export to a stand-in for Langfuse (`e2e/src/capture.ts`, OTLP protobuf and JSON, the ingestion API), and every span tree (names, kinds, parents, attributes, statuses, events) and every score of about 90 quotes is compared |

What the trace comparison leaves out, because the exporter sets it and
Langfuse reads none of it: the resource's `telemetry.sdk.*`,
`service.instance.id`, `process.*`, `host.*` and `os.*`; the
instrumentation scope (`trpc.agent.go`, `langfuse-sdk`); the SDKs'
`langfuse.internal.*` attributes (`is_app_root`); an exception event's
`exception.type`, `exception.stacktrace` and `exception.escaped`, which name
a language's own types. Replaced by placeholders: trace and span ids, quote
ids, times, durations, the `latency_ms` score, the quoter's name.
