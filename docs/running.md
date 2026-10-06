# Running Delorean

The README gives the two commands. This page has the rest: the ports, the
quoter on its own, a run without Docker, the demo reader of the fake engines,
and the live mode.

## With Docker, no key, no cost

You need Docker. The models are replaced by deterministic fake engines.

```sh
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build
```

Then open <http://localhost:24790> and paste one of the carts of the README.
Without a key the page says so in a banner, « mode démo : lecteur simplifié,
pas d'IA »: the fake engines are a small deterministic reader. It reads one
title per line, with an optional quantity in front (`2 Back to the Future 2`,
`2 x …`), the saga's titles with 1/2/3 or I/II/III, in any case and spacing,
and prices the five examples exactly; a line of another film (`La chèvre`) is
one film at 20 €. What it cannot read safely, such as several titles on one
line, is refused with a sentence (« le mode démo lit un titre par ligne »)
instead of a wrong price. The page offers only the examples the fake can read
([how the fakes work](architecture.md#fake-engines-enginesfake)).

## With the real models

Add the key and a daily spending cap (the web app does not start on live
engines without one) to the same `.env`:

```sh
cat >> .env <<'EOF'
ENGINES=live
OPENROUTER_API_KEY=sk-or-…
DAILY_BUDGET_USD=5
EOF
docker compose up --build
```

What live mode costs and guarantees:
[testing](testing.md#what-live-mode-costs-and-what-it-guarantees). Every
variable: [architecture](architecture.md#configuration).

Traces in Langfuse are optional (`task langfuse:up`, see
[`deploy/langfuse`](../deploy/langfuse)); nothing requires them.

## Ports

| Service | URL | Port variable |
|---|---|---|
| Web app (Next.js: page + BFF) | <http://localhost:24790> | `WEB_PORT` |
| Quoter (Node) | <http://localhost:24793/healthz> | `QUOTER_PORT` |
| Documentation site | <http://localhost:24795> | `DOCS_PORT` |
| Langfuse (optional) | <http://localhost:24794> | |

compose publishes them on `127.0.0.1` only; set the variables in `.env` to
move a port.

## The quoter alone, without the web app

```sh
curl -s localhost:24793/v1/quotes -H 'content-type: application/json' \
  -d '{"cart":"Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre"}'
# {"id":"q_…","currency":"EUR","lines":[…],"total_cents":5600,…}
```

The total is `total_cents`: 5600, that is 56.00 €. (`| jq .total_cents` prints
just that if you have jq; nothing here needs it.)

## Without Docker

Node 22 (22.18 or later) or 26 is the only requirement. With
[go-task](https://taskfile.dev):

```sh
task setup
task quoter:run:fake          # the quoter on :24793, fake engines
cd web && npm run dev         # in another terminal: the web app on :24790
```

Without go-task, the same in plain commands:

```sh
cd quoter && npm ci && ENGINES=fake node src/main.ts     # the quoter on :24793
cd web && npm ci && npm run dev                          # in another terminal
```

The web app finds the quoter at `QUOTER_URL` (`http://localhost:24793` when
unset) and, in development, needs no `SESSION_SECRET` (it warns and uses a
development one); in production mode (`npm run build && npm start`) it needs
`SESSION_SECRET`, 32 characters or more.
