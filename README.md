# Delorean

A web app where a customer types a DVD cart as free text and gets the price.

```
Back to the Future 1
Back to the Future 2
Back to the Future 3
La chèvre                    →   56,00 €
```

The text can be a list, a sentence, a story, in several languages, with
quantities in digits or in words. Delorean reads it, refuses what is not an
order, and returns a detailed price. **Models read, code counts**: no amount
ever comes out of a model.

## The business

The three *Back to the Future* films cost **15 €** each, every other film
**20 €**. The saga is discounted by the number of **different volumes** in the
cart: 1 volume none, 2 volumes **−10 %**, 3 volumes **−20 %**, on every saga
DVD. Another film is never discounted; a second copy of a volume is priced and
counts in the discount's base, but is not a new volume.

| # | Cart | Price | Why |
|---|---|---|---|
| 1 | Back to the Future 1, 2, 3 | **36 €** | 3 × 15 = 45, three volumes: −20 % |
| 2 | Back to the Future 1, 3 | **27 €** | 2 × 15 = 30, two volumes: −10 % |
| 3 | Back to the Future 1 | **15 €** | one volume: no discount |
| 4 | Back to the Future 1, 2, 3, 2 | **48 €** | 4 × 15 = 60, still three volumes: −20 % |
| 5 | Back to the Future 1, 2, 3 and *La chèvre* | **56 €** | (3 × 15 − 20 %) + 20 |

Computed in [`quoter/src/pricing.ts`](quoter/src/pricing.ts): integer cents, no model.

## Run it

You need Docker. No key, no cost: the models are replaced by deterministic fake
engines (the page says so in a banner).

```sh
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build        # then open http://localhost:24790
```

With the real models (OpenRouter), add the key and a daily spending cap to the
same `.env` (the web app refuses to start on live engines without a cap):

```sh
printf 'ENGINES=live\nOPENROUTER_API_KEY=sk-or-…\nDAILY_BUDGET_USD=5\n' >> .env
docker compose up --build
```

Ports, the quoter alone with `curl`, a run without Docker, the fake reader:
[`docs/running.md`](docs/running.md).

## Test the five examples

```sh
task test                        # unit tests, then the end-to-end suite on the fake engines
cd quoter && npm test -- brief   # only the five examples, from the cart as typed to the total
```

The five carts are [`quoter/test/brief.test.ts`](quoter/test/brief.test.ts) and
the shared cases [`cases/quote/enonce-*.json`](cases/quote). No test calls a
model: with the real models the examples were checked by hand and by the
benches, not by a test ([what is guaranteed, and where](docs/testing.md#what-live-mode-costs-and-what-it-guarantees)).
Other commands (`task web:e2e` in a browser, `task bench`, `task check`):
[`docs/testing.md`](docs/testing.md).

## Design choices

```
browser ─► web (Next.js: page + BFF) ─► quoter (TypeScript, Node)
  prepare → guard (Jev) → parse + recount (LLM) → identify (Jev) → judge → price (code)
```

- **Jev decides, the LLM extracts, the code counts.** At worst a title is
  misread, never an amount invented.
- **Two readings, compared in code, then a judge** before every price; a
  refused reading is read again (3 at most), never re-judged as is.
- **The recount is a second opinion, not a dependency**: left out when it fails,
  and then a line of several copies is refused rather than guessed.
- **An injection cannot set a price**: the guard rejects it, the BFF blocks a
  visitor after three refusals and caps the day's spending.
- **Bounded in time and size**, **contract first** (`api/openapi.yaml`), and
  **fake engines** so everything is tested without paying.

The reasons and thresholds are in [`docs/architecture.md`](docs/architecture.md#design-decisions);
why a text is read with models and not with a parser:
[`docs/adr/0001-lire-le-panier-avec-des-modeles.md`](docs/adr/0001-lire-le-panier-avec-des-modeles.md).

Layout: `quoter/` pipeline and pricing · `web/` page and BFF · `api/` contract · `prompts/` · `cases/` + `e2e/` · `docs/` · `deploy/`, `scripts/`.
