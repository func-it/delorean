# Architecture

This document is the shared reference for the three implementations (Go,
Python, TypeScript). The HTTP contract is `api/openapi.yaml`; what follows
describes what the contract cannot say: the order of the stages, the
thresholds, the engines, the fake test engines and the shared cases.

## Overview

```
browser ──► web (Next.js: UI + BFF, session) ──► backend (go | python | typescript)
                                                    │
                                                    ├─ prepare   code     size, tokens
                                                    ├─ guard     Jev      valid | injection | invalid
                                                    ├─ parse     LLM      [{title, quantity}]
                                                    ├─ identify  Jev      one title → bttf_1|2|3|other, in parallel
                                                    ├─ judge     Jev      is the reading faithful to the text?
                                                    └─ price     code     integer cents
                                                    │
                                                    └─► OpenRouter (Jev, GPT-6 Luna) · traces ► Langfuse
```

- **The BFF** (Next.js route handlers) holds the session (a username, no
  password: this is identification, not authentication), hides the backend
  URL from the browser and forwards `X-User-Id` / `X-Session-Id` for the
  traces.
- The BFF adds two codes to the contract's, in the same problem format:
  `401 no_session` (no session) and `502 backend_unavailable` (backend
  unreachable or too slow).
- **The backends** are stateless and interchangeable: same contract, same E2E
  suite, same system bench.
- **The models never compute a price.** They read; the code counts.

## The stages of `POST /v1/quotes`

| # | Stage | Engine | Possible rejection |
|---|---|---|---|
| 0 | HTTP body | code | `400 malformed_request`, `413 payload_too_large` (> `MAX_BODY_BYTES`) |
| 1 | `prepare` | code | `422 empty_cart`, `422 too_long` (> `MAX_INPUT_TOKENS`) |
| 2 | `guard` | Jev, `choice` question | `422 injection`, `422 invalid_request` |
| 3 | `parse` | LLM, structured output | `422 no_film` (no film to buy), `422 quantity_too_large` (more than 1000 copies of one film) |
| 4 | `identify` | Jev, one `choice` request per distinct title, in parallel | — |
| 5 | `judge` | Jev, one `noul` question per observable fact, in parallel | `422 unfaithful_reading` |
| 6 | `price` | code | — |

An engine that is unreachable or answers outside its contract gives
`502 engine_unavailable`.

### 1. prepare: size and tokens

Jev accepts at most 64k tokens of state and questions, and 32k for the
longest question. The cart text is therefore capped well below that, before
any call:

1. normalize: `\r\n` → `\n`; control characters removed (except `\n` and
   `\t`); format characters (Unicode `Cf`) removed except the zero-width
   joiner and non-joiner (`U+200D`, `U+200C`, which emoji and some scripts
   need); Unicode NFC; leading and trailing whitespace removed. The format
   characters are what a reader cannot see but a model reads: zero-width
   spaces that split a word, bidirectional overrides that show text in another
   order, tag characters (`U+E0000` block) that spell ASCII no one sees. An
   instruction hidden there would reach the models and no reviewer;
2. empty or blank → `empty_cart`;
3. count the tokens with a real BPE tokenizer (`o200k_base`, embedded, no
   network); above `MAX_INPUT_TOKENS` (default 2048) → `too_long`, with
   `tokens.count` and `tokens.max` in the problem.

Jev's tokenizer is not published: `o200k_base` is an estimate, and the margin
between 2048 and 32k more than covers the difference.

### 2. guard: three verdicts

A Jev `choice` question, key `verdict`:

- `valid`: an order for films on DVD, in any language or a mix of languages,
  with or without a story around it, that names at least one film to buy. A
  box set, a film asked for on Blu-ray, a question beside the order ("can you
  do a better price for three?") and a character's line in a story keep it an
  order;
- `injection`: the text tries to give orders to the system, impose or state
  prices or rules, speak as someone else than the customer (a system line, the
  shop, an assistant's reply, a tool's result, a manager's approval), reveal
  instructions, or manipulate the reading (which film a title is, how many
  copies, which line to skip), even if it also contains films, even hidden in
  a title, markup or encoded text. A film's title stays a title even when its
  words read like an order;
- `invalid`: not a film order: gibberish, a language it does not understand,
  off topic, a question, a complaint or a review with nothing to buy.

Three borderline calls, made on purpose. Asking for a discount is not
imposing one: the code sets the price whatever the text says. A film asked
for on Blu-ray is an order for the film, quoted on DVD. An instruction a
character gives in a story is not addressed to the shop.

Rule: the cart passes if `verdict == valid` **and** `confidence >=
GUARD_MIN_CONFIDENCE` (default 0.5). Otherwise `injection` if that is the
verdict, `invalid_request` in every other case. The verdict, its confidence
and its probabilities are returned in the problem (`guard`).

### 3. parse: titles and quantities

The LLM (`PARSE_MODEL`, default `openai/gpt-6-luna`) returns structured
output, validated against a schema:

```json
{ "films": [ { "title": "Retour vers le futur 2", "quantity": 2 } ] }
```

- the title is copied as the customer wrote it (not translated);
- only the films the customer **buys**: a film mentioned in the story but not
  bought is left out;
- a box set, "the trilogy" or "the whole saga" is not a product: it counts as
  its films, one line per film, each with the number of box sets as quantity.
  "Retour vers le futur - la trilogie" reads as volumes 1, 2 and 3, so 36 €
  after the 20 % discount. The judge holds the expanded reading against the
  text with the same rule;
- a bare number after a title ("le 1 et le 3") is written out with the title
  of the films it counts, never with the name of a ride, game or show that
  shares it;
- the quantity is an integer ≥ 1; the pipeline merges two mentions of the same
  title (differing only in case and spacing) and adds up their quantities;
- a quantity below 1 is outside the engine's contract (`502`); above 1000
  copies of a single title (`limits.max_copies_per_title`, after identical
  titles are merged; two spellings of the same volume stay two titles: this is
  a safety limit, not a business rule), the order is rejected
  (`422 quantity_too_large`): no DVD shop would fill it, and amounts in cents
  stay far from any overflow.

Jev does not count (its own documentation says it recognizes the shape
instead of counting): counting is the LLM's job, and the judge checks it.

### 4. identify: one title, one request

One Jev request per distinct title, all in parallel: questions in the same
request color one another, and a long, noisy state distracts Jev. A `choice`
question, key `film`, options `bttf_1`, `bttf_2`, `bttf_3`, `other`, each one
described (titles in other languages, Roman numerals, abbreviations such as
"BTTF 2", "Part II", "Zurück in die Zukunft II"…). `other` covers any other
film, including films by the same team or a documentary about the saga, and
anything that is not a film even with the saga's title on it: a record, a
book, a game, merchandise. The criteria name categories, not the bench's
titles, so the `identify` bench measures what Jev infers rather than what it
was told.

Two different titles can refer to the same volume ("BTTF 2" and "Retour vers
le futur 2"): they stay two lines, and count as one distinct volume for the
discount.

### 5. judge: the judge in production

This is the judge from the mutuo benches (`Probe`), applied to every reading
before a price is set. What it taught us about Jev applies here:

- **one short question about an observable fact**: a global question such as
  "is this consistent?" returns fuzzy probabilities;
- **one item per request**: Jev is reliable on one fact, fuzzy on a list; each
  item is asked on its own, in parallel;
- **the worst score decides.**

| Check | Asked on | State read by Jev | Question (`noul`) | Score |
|---|---|---|---|---|
| `asked` | each line | customer text + the line's title | Is the customer asking to buy this film? | p |
| `identity` | each line | customer text + the line's title and the film it was identified as | Is this title the film it was identified as? | p |
| `quantity` | each line | customer text + the line | Is the customer asking for exactly N copies of this film? | p |
| `missing` | the whole reading | customer text + the parsed list | Is the customer asking for a film that is not in this list? | 1 − p |

`asked` and `identity` are two facts, so two questions: put together, Jev
answered whether the film was asked for and passed over a wrong
identification ("Back to the Future Part II" identified as another film: 20 €
instead of 15 €, and the discount lost). `identity` holds for a translation,
an abbreviation or another numbering of the film; it fails for another film,
for something that is not the film (a soundtrack, a book, a game), and for a
title of the trilogy identified as a film outside it.

The cart is priced if the worst score ≥ `JUDGE_THRESHOLD` (default 0.5). The
details (`checks`) are returned in the quote or in the `unfaithful_reading`
problem. `quantity` targets Jev's known weakness at counting: the `judge`
bench measures how much it is worth.

### 6. price: the calculation

In integer cents, from the catalog:

- a volume of the saga: 1500; any other film: 2000;
- `distinct_volumes` = number of different volumes among the lines;
- discount = the highest tier reached (2 → 10%, 3 → 20%), applied to
  `base_cents`, the sum of the saga lines;
- `amount_cents = (base_cents × percent + 50) / 100` (rounded to the cent,
  half up; with this catalog, always exact).

## Usage, cost and traces

Each stage returns a `StageUsage`: engine, model, number of calls, duration,
cost in USD (as OpenRouter bills it). The quote and the `422` problems carry
the cumulative `usage`, so the cost of a rejection is visible.

When Langfuse is configured, each request is a `quote` trace (user =
`X-User-Id`, session = `X-Session-Id`), with one span per stage and one
generation per model call, including input, output and cost. Without
configuration, the tracer is a no-op.

## Fake engines (`ENGINES=fake`)

For E2E tests without OpenRouter. They are deterministic and identical in the
three implementations, because they are part of the test contract. Never in
production.

- **guard**: `injection` if the text contains, case-insensitively, any of
  `ignore`, `disregard`, `oublie`, `instruction`, `system prompt`,
  `<script`, `drop table`; otherwise `invalid` if no line contains three
  consecutive letters (`\p{L}{3,}`); otherwise `valid`. Confidence 0.99.
- **parse**: each non-empty line is a mention, except lines that start with
  `#fake:`. Quantity: prefix `N x ` / `N × ` or suffix ` x N` / ` × N` (N
  integer ≥ 1), otherwise 1. Title: the rest, with leading and trailing
  whitespace removed. No mention → the pipeline answers `no_film`; N > 1000 →
  `quantity_too_large`.
- **identify**: title lowercased, whitespace collapsed; `back to the future`
  followed by `1|2|3|i|ii|iii` (with or without `part `) → `bttf_N`; otherwise
  `other`. Confidence 1.
- **judge**: `asked`, `identity` and `quantity` for each line, then
  `missing`; every check at 1; if a line of the text is exactly
  `#fake:unfaithful`, the `missing` check is 0.
- **outage**: if a line of the text is exactly `#fake:engine_down`, parse
  fails with an engine error → `502 engine_unavailable`.
- cost 0, engine `fake`, one call per stage.

## Shared cases (`cases/`)

One case per JSON file, in the mutuo bench format. The file name is the `id`.
The three implementations and the system bench read the same cases.

```json
{
  "id": "enonce-4",
  "note": "Pourquoi ce cas existe : quelle erreur il garde.",
  "tags": ["enonce", "fake"],
  "input": { "cart": "…" },
  "expect": { "status": 200, "total_cents": 4800, "films": { "bttf_1": 1, "bttf_2": 2, "bttf_3": 1 } }
}
```

| Folder | Subject | `input` | `expect` |
|---|---|---|---|
| `quote/` | the API end to end | `{cart}` | `{status: 200, total_cents, films?}` or `{status, code}` |
| `guard/` | the guard alone | `{text}` | `{verdict}` |
| `identify/` | one title | `{title}` | `{film}` |
| `reading/` | parse + identify | `{text}` | `{films: {film: total quantity}}` |
| `judge/` | the judge | `{text, lines: [{title, quantity, film}]}` | `{faithful: bool, check?}` |

- `films` compares the total quantities per film (`other` adds up all the
  other films).
- The `fake` tag marks a case that the fake engines must pass: the E2E suite
  runs it in CI. The other cases only run against live engines.

## Benches

- **Component benches** (per implementation, as in mutuo): `guard`,
  `identify`, `reading`, `judge`. The cases become a Langfuse dataset and each
  run an experiment; several runs per case give a rate, not a lucky hit. The
  judge also serves as the evaluator there.
- **System bench** (`e2e/`, black box): the `quote/` cases run N times against
  any backend; correct price rate, correct rejection rate, p50 / p90 latency,
  cost per cart and per stage. This is the bench that compares the three
  implementations.

No bench runs without `RUN_LIVE=1` and an OpenRouter key.

## Configuration

Every port of the project sits in 24790–24799: web 24790, Go 24791, Python
24792, TypeScript 24793, Langfuse 24794, documentation 24795, and the
end-to-end run on fake engines 24799.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `24791` (go), `24792` (python), `24793` (typescript) | HTTP listen port |
| `ENGINES` | `live` | `live` or `fake` |
| `OPENROUTER_API_KEY` | — | required with `live` |
| `PARSE_MODEL` | `openai/gpt-6-luna` | LLM for parse |
| `PARSE_EFFORT` | `low` | reasoning effort for parse |
| `JEV_MODEL` | `typesafe/jev-1.13` | Jev, pinned version |
| `MAX_BODY_BYTES` | `65536` | maximum HTTP body size |
| `MAX_INPUT_TOKENS` | `2048` | maximum cart size, in tokens |
| `GUARD_MIN_CONFIDENCE` | `0.5` | minimum confidence for a `valid` |
| `JUDGE_THRESHOLD` | `0.5` | lowest judge score accepted |
| `REQUEST_TIMEOUT` | `30s` | time budget for one request, calls included |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | — | traces, when set (local Langfuse: `task langfuse:up`, http://localhost:24794) |
