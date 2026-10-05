# Delorean

A web app where a customer types a DVD cart as free text and gets the price.

```
Back to the Future 1
Back to the Future 2
Back to the Future 3
La chèvre                    →   56,00 €
```

The customer writes the cart however they like: a list, a sentence, a story,
several languages, quantities in digits or in words. Delorean reads the text,
refuses what is not an order, and returns a detailed price.

**Models read, code counts.** No amount ever comes out of a model.

## The business

A DVD shop sells the three *Back to the Future* films at **15 € each** and
every other film at **20 €**. The saga has a discount, on every Back to the
Future DVD of the cart, by the number of **different volumes** in it:

| Different volumes of the saga in the cart | Discount on every Back to the Future DVD |
|---|---|
| 1 | none |
| 2 | 10 % |
| 3 | 20 % |

Another film is always full price and is never discounted. A second copy of a
volume is priced and counts in the discount's base, but it is not a new volume.

### The five examples of the brief

| # | Cart | Price | Why |
|---|---|---|---|
| 1 | Back to the Future 1, 2, 3 | **36 €** | 3 × 15 = 45, three volumes: −20 % |
| 2 | Back to the Future 1, 3 | **27 €** | 2 × 15 = 30, two volumes: −10 % |
| 3 | Back to the Future 1 | **15 €** | one volume: no discount |
| 4 | Back to the Future 1, 2, 3, 2 | **48 €** | 4 × 15 = 60, still three volumes: −20 % |
| 5 | Back to the Future 1, 2, 3 and *La chèvre* | **56 €** | (3 × 15 − 20 %) + 20 |

They are tests, and they pass on the fake engines, from the cart as typed to
the total: [`quoters/typescript/test/brief.test.ts`](quoters/typescript/test/brief.test.ts)
(`cd quoters/typescript && npm test -- brief`). The same five carts are
shared cases ([`cases/quote/enonce-*.json`](cases/quote)) that the end-to-end
suite plays against a running service.

### Where the price is computed

[`quoters/typescript/src/pricing.ts`](quoters/typescript/src/pricing.ts): about
a hundred lines, integer cents, no model, no text. It takes lines already
identified (a film, a quantity) and returns the price; its unit tests are in
[`test/pricing.test.ts`](quoters/typescript/test/pricing.test.ts). A model
never sees an amount and the code never sees the customer's words: the rest of
this repository is how a text becomes those lines, and what happens when it
cannot.

## How a text becomes a price

```
browser ─► web (Next.js: page + BFF) ─► quoter (TypeScript, on Node)
                                          │
   prepare   code      normalizes the text, counts tokens, bounds the size
   guard     Jev       is it an order? does it speak to the system? → valid | injection | invalid
   parse     LLM       titles and quantities (GPT-6 Luna, strict JSON schema)   ┐ side by side
   recount   LLM       the same reading, again (GPT-6 Luna, no reasoning)       ┘
   identify  Jev       each distinct title → volume 1, 2, 3 or another film
   judge     Jev+code  is the reading faithful to the text? do both readings count the same?
                       a refused reading is read again, told what failed: 3 readings at most
   price     code      integer cents (pricing.ts)
                                          │
                              OpenRouter (Jev, GPT-6 Luna) · traces → Langfuse (optional)
```

Jev (TypeSafe) answers a typed question with calibrated probabilities and
cannot answer outside its options: it decides (is this an order, which film is
this title, is this reading faithful). It does not count, so an LLM extracts
titles and quantities under a strict JSON schema, and the code compares two
readings. Every stage may refuse the cart with a stable code (`too_long`,
`injection`, `invalid_request`, `no_film`, `quantity_too_large`,
`unfaithful_reading`…) and says why. Every quote carries the cost and
duration of each stage. The contract is one OpenAPI file,
[`api/openapi.yaml`](api/openapi.yaml); every word put to a model is in
[`prompts/`](prompts).

## Run it

You need Docker. Two commands, no key, no cost: the models are replaced by
deterministic fake engines.

```sh
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build
```

Then open <http://localhost:24790>, paste one of the carts above. The fake
engines recognise "Back to the Future 1/2/3" written as is and a few
directives; they exist for tests ([how they work](docs/architecture.md#fake-engines-enginesfake)).

With the real models, add the key and a daily spending cap (the web app does
not start on live engines without one) to the same `.env`:

```sh
cat >> .env <<'EOF'
ENGINES=live
OPENROUTER_API_KEY=sk-or-…
DAILY_BUDGET_USD=5
EOF
docker compose up --build
```

A four-film cart takes about 17 model calls (15 Jev, 2 LLM) and costs about a
tenth of a cent. Traces in Langfuse are optional (`task langfuse:up`, see
[`deploy/langfuse`](deploy/langfuse)); nothing requires them.

| Service | URL |
|---|---|
| Web app (Next.js: page + BFF) | <http://localhost:24790> |
| Quoter (TypeScript) | <http://localhost:24793/healthz> |
| Documentation site | <http://localhost:24795> |
| Langfuse (optional) | <http://localhost:24794> |

The quoter alone, without the web app:

```sh
curl -s localhost:24793/v1/quotes -H 'content-type: application/json' \
  -d '{"cart":"Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre"}' | jq .total_cents
# 5600
```

Without Docker, Node 26 is enough: `task setup`, then `task ts:run:fake` (the
quoter on :24793) and `cd web && npm run dev` (the web app on :24790).

## Tests

| What | Command | Cost |
|---|---|---|
| Unit tests (quoter, web, e2e harness), the five examples included | `task test` | none |
| End-to-end suite against a running quoter, fake engines | `task e2e` | none |
| The web app in a browser (Playwright, desktop and phone), whole stack on fake engines | `task web:e2e` | none |
| System bench of the quoter (accuracy, latency, cost) | `task bench -- --base-url http://localhost:24793 --runs 3` | OpenRouter if live |
| Everything CI runs | `task ci` | none |

No test calls a model. The details, the shared cases, and the results of the
benches that chose the models are in [`docs/testing.md`](docs/testing.md).

## Design decisions

- **Jev decides, the LLM extracts, the code counts.** A model never computes a
  price; at worst a title is misread, never an amount invented.
- **A judge before every price.** The reading is held against the text by
  short questions, one per observable fact (is this film asked for? is the
  title the film it was identified as? is a film missing?), asked separately;
  the worst score decides.
- **Two readings, compared in code.** Jev cannot count, so the cart is read a
  second time and the code compares both readings film by film; a
  disagreement refuses the cart. The recount is the parser's own model without
  reasoning, chosen for its speed, so its readings are correlated: it catches
  a model that reads the same cart differently from one call to the next, not
  one that misreads it the same way twice.
- **The recount is a second opinion, not a dependency.** One that fails or is
  too slow is asked once more if it failed fast, then left out: the quote goes
  on with the parse alone and the judge, its usage says `degraded`, and with
  nothing to count against a line of several copies is refused to retry
  (`503 quantity_unverified`), single copies are priced.
- **A refused reading is read again, never re-judged as is.** It goes back to
  the model with what failed, up to three readings; only a different reading
  goes back to Jev.
- **An injection cannot set a price.** The guard rejects it; the BFF blocks a
  visitor after three refusals, bounds the rate and the spending per address,
  and caps the day's budget.
- **Every model call and request is bounded in time and size:** 256 tokens and
  8 KB a cart, `MODEL_TIMEOUT` 6 s a call, 15 s a request.
- **Contract first, fake engines to test without paying.** One `openapi.yaml`,
  shared cases, an end-to-end suite that any implementation of the contract
  can run against.
- **A box set is its films.** "The trilogy" counts as the three volumes.

The reasons, the thresholds and the history (the project began as three
implementations of one contract, in Go, TypeScript and Python; one was kept)
are in [`docs/architecture.md`](docs/architecture.md).

## Repository

```
api/openapi.yaml      the contract, source of truth
quoters/typescript/   the quoter: pipeline, engines, pricing, API (Node)
web/                  Next.js: the page, the BFF, the session, the budget
prompts/              every word put to a model
cases/                shared cases: quote, guard, identify, reading, judge
e2e/                  end-to-end suite and system bench, for any quoter
docs/                 architecture, testing, and the documentation site
deploy/               Langfuse (optional), the docs server, the browser-test stack
scripts/              end-to-end and browser-test runners, docs, Langfuse secrets
```

## Further reading

- [`docs/architecture.md`](docs/architecture.md): the stages, thresholds,
  judge, fake engines and configuration.
- [`docs/testing.md`](docs/testing.md): tests, cases, benches and their results.
- [`api/openapi.yaml`](api/openapi.yaml): the HTTP contract.
- [`quoters/typescript/README.md`](quoters/typescript/README.md),
  [`web/README.md`](web/README.md) and [`e2e/README.md`](e2e/README.md): each
  part on its own.
