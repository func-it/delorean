# web: the interface and the BFF

Next.js (App Router): one page where you write your cart and read the price
(a title, a text area, a button; the total, the lines and the saga discount;
one sentence for a refusal; the reading, the judge and the cost behind a
discreet « détails »; the price rules in one line in the footer), and the BFF (route
handlers) that holds the session, hides the quoter URLs from the browser and
forwards `X-User-Id`, `X-Session-Id` and `X-Request-Id`. See
[`docs/architecture.md`](../docs/architecture.md).

## Running

```sh
npm ci
cp .env.example .env.local   # then adjust
npm run dev                  # http://localhost:24790
```

You need a quoter that responds (`http://localhost:24791` by default), for
example the TypeScript quoter with `ENGINES=fake`.

Docker image (`standalone` output, non-root user, port 24790):

```sh
docker build -t delorean-web .
docker run -p 24790:24790 -e SESSION_SECRET=… -e QUOTER_URL=http://go:24791 delorean-web
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_SECRET` | development secret, with a warning | seals the session cookie; at least 32 characters, **required in production** |
| `QUOTER_URL` | `http://localhost:24793` | the quoter the BFF calls, from the environment only: the browser names nothing about where a request goes |
| `SESSION_COOKIE_SECURE` | `true` in production | `false` when the app is served over plain HTTP (`docker compose` locally): some browsers reject a `Secure` cookie received over HTTP, even from localhost |
| `QUOTER_TIMEOUT_MS` | `20000` | maximum wait for a quoter (a little more than its 15 s) |
| `STRIKE_LIMIT` | `3` | injection refusals that block a session or a username ([strike rule](#strike-rule)) |
| `IP_STRIKE_LIMIT` | `10` | injection refusals that block a client address, which a carrier's NAT may share between many customers |
| `IP_MAX_IN_FLIGHT` | `4` | quotes in flight at once from one client address (a session or a username: one) |
| `STRIKE_WINDOW_S` | `900` | the window those refusals are counted in, in seconds |
| `STRIKE_BLOCK_S` | `900` | how long a block lasts, in seconds |
| `REFUSAL_MEMORY_S` | `21600` | how long a text refused as an injection is answered from memory, in seconds |
| `DAILY_BUDGET_USD` | `0` (no cap) | daily spending cap in USD, UTC day, over the quoter's `usage.cost_usd` ([daily budget](#daily-budget)) |
| `BUDGET_FILE` | `.data/budget.json` | where the day's total is kept; `/data/budget.json` in `docker compose`, on the `web-data` volume |
| `UNANSWERED_QUOTE_COST_USD` | `0.002` | what a quote that got no usable answer counts for in the budgets (the quoter too slow, unreachable, or failing without a usage), since it may have spent; `0` counts nothing |
| `IP_DAILY_BUDGET_USD` | a quarter of `DAILY_BUDGET_USD` | one client address's share of the day's budget; `0` for no share ([per-address share](#per-address-share)) |
| `IP_RATE_LIMIT` | `20` | quotes one client address may send within `IP_RATE_WINDOW_S`; `0` for no limit ([rate](#rate-per-address)) |
| `IP_RATE_WINDOW_S` | `60` | the window of that rate, in seconds |
| `MAX_BODY_BYTES` | `8192` | the quoter's own limit on the body `{"cart": …}`, one figure from the browser to the quoter (compose gives it to both): the page sends no cart over it, the BFF reads that much, then `413 payload_too_large` |
| `MAX_INPUT_TOKENS` | `256` | the quoter's limit on a cart in tokens: the page only uses it to say, in characters (about three to a token), when a cart nears it |
| `ENGINES` | — | `live` or `fake`, what the quoter runs on (compose passes it along): with `live` and no `DAILY_BUDGET_USD` the app **refuses to start** ([daily budget](#daily-budget)); absent, nothing is checked |
| `TRUST_PROXY_HOPS` | `0` | how many proxies of ours stand in front of the app, each appending to `X-Forwarded-For` ([client address](#client-address)) |

The browser picks a quoter by its **name**, checked against this list, never
by URL.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | development server |
| `npm run build`, `npm start` | production build (`.next/standalone`, the one the image uses), then server; `start` reads `.env.local` if it exists |
| `npm test` | Vitest: BFF and libraries (Node), components (jsdom) |
| `npm run e2e` | Playwright (`e2e/`): the page in a real browser, desktop and mobile, against a running stack at `BASE_URL`; `task web:e2e` starts one on fake engines, apart from any other ([testing](../docs/testing.md#web-app-in-a-browser-playwright)) |
| `npm run lint`, `npm run typecheck` | ESLint, `tsc --noEmit` |
| `npm run generate` | regenerates `src/generated/api.d.ts` from `../api/openapi.yaml` (the file is committed: the Docker build only needs `web/`) |

## Session

**Identification, not authentication**: no login page. The first quote of a
visitor starts an anonymous session with a generated name
(`visiteur-1a2b3c4d`), used to group traces by visit and to key the
[strike rule](#strike-rule) and the budget. The cookie (`httpOnly`, `SameSite=Lax`,
`Secure` in production) is encrypted and signed by iron-session; it contains
`{username, sessionId, createdAt}`.

## BFF

| Route | Quoter | Notes |
|---|---|---|
| `POST /api/quotes` | `POST /v1/quotes` | starts the anonymous session if there is none; body `{cart}`; the quoter's status and JSON are passed through unchanged, after the [strike rule](#strike-rule) |
| `GET /api/catalog` | `GET /v1/catalog` | revalidated every 60 s; no session needed; the page does not call it |

On top of the contract's codes, the BFF adds its own, in the same format
(RFC 9457):

- `too_many_refusals` (429): the session, the username or the client address
  is blocked by the strike rule; `Retry-After` and `retry_after_s` say for how
  many more seconds;
- `quote_in_progress` (429): a quote is already in flight for the session or
  the username, or `IP_MAX_IN_FLIGHT` for the client address;
  `Retry-After: 1`;
- `daily_budget_exhausted` (503): the day's [budget](#daily-budget) is spent;
  `Retry-After` and `retry_after_s` say how many seconds remain until
  midnight UTC;
- `ip_budget_exhausted` (429): the client address spent its [share](#per-address-share)
  of the day's budget; `Retry-After` and `retry_after_s` until midnight UTC;
- `rate_limited` (429): the client address sent more than `IP_RATE_LIMIT`
  quotes within `IP_RATE_WINDOW_S` ([rate](#rate-per-address)); `Retry-After`
  and `retry_after_s` say how many seconds to wait;
- `payload_too_large` (413): the body is over `MAX_BODY_BYTES`; it is never
  read past it, and `Content-Length` over it is refused before reading;
- `quoter_unavailable` (502): the quoter is unreachable, too slow, or
  answers outside the contract.

## Strike rule

The guard is a probabilistic classifier: a variant it lets through one time in
three gets through 70 % of the time in three tries (1 − (2/3)³), and every try
costs model calls. So the BFF limits the tries (`src/lib/strikes.ts`):

- every `422` with `code: "injection"` counts a strike on three keys: the
  session id, the username and the client address;
- `STRIKE_LIMIT` strikes (3) within `STRIKE_WINDOW_S` on a session or a
  username, `IP_STRIKE_LIMIT` (10) on an address, block that key for
  `STRIKE_BLOCK_S`; while one of its keys is blocked, a request gets
  `429 too_many_refusals` at once, and the quoter is not called;
- the refused text is remembered for `REFUSAL_MEMORY_S`, per visitor (the
  client address, or the session when there is none) and under the SHA-256 of
  the text **as the quoter reads it** (`src/lib/normalize.ts`: the same rule as
  the quoter's `prepare`: LF line ends, nothing invisible but `\n`, `\t` and the
  joiners, NFC, trimmed): sent again by that visitor, whatever invisible
  characters differ, it gets the same `422` at once, with `"remembered": true`
  and without the original call's `usage`. It counts as a strike all the same.
  Resending a text cannot draw the guard again. What one visitor had refused
  is nothing to another: they are not served it, and ask the guard themselves;
- no other code counts: `invalid_request`, `no_film` and the rest never block;
- quotes in flight: one per session and per username, `IP_MAX_IN_FLIGHT` (4)
  per address; a request on a full key gets `429 quote_in_progress`
  (`Retry-After: 1`) at once. The keys are taken all or none before the block is checked, and
  released in a `finally`, whatever the answer. Without this, requests sent in
  parallel would all reach the guard before the first refusal came back.

The UI says each in one French sentence: the wait in minutes, "Ce panier a déjà
été refusé…", and "Un devis est déjà en cours…".

The session and its generated name cost nothing to renew (clear the cookie;
identification, not authentication), so the address is the key a client
cannot change, and the memory is keyed on it.

An address gets looser limits than a visitor because a carrier's NAT puts many
mobile customers behind one IPv4: ten refusals among them before a block, four
quotes at once before a `quote_in_progress`. The price, on purpose: an attacker
gets that much room per address, and still only three refusals per session
and username, each renewed by clearing the cookie.

### Storage

`MemoryStrikeStore`, behind the `StrikeStore` interface, with an injectable
clock for the tests. Expired entries are swept as the store is used (at most
once a minute, no timer); the keys (50,000) and the remembered refusals (5,000)
are capped, the least recently used going first; the keys in flight are as
many as the requests. It lives in one process: **several instances need a
shared store**, such as Redis (a sorted set per key for the window, `SET … PX`
for the blocks and the refusals, `SET … NX PX` for the keys in flight, the
lease outliving `QUOTER_TIMEOUT_MS` in case an instance dies), behind the
same interface, whose methods already return promises.

## Daily budget

Nothing else bounds what a public demo costs in model calls, so the BFF keeps
a daily total (`src/lib/budget.ts`). Every Quote and every quoter Problem
carries `usage.cost_usd`; the BFF adds it to the day's total after relaying
the answer. A failure counts too: the quoter puts the usage of the stages that
ran on a `502` and a `500`, a call that went out being counted answered or not.
What carries no usage costs nothing (a refusal of the BFF's own, a remembered
refusal), but for a failure that says nothing of its cost: the quoter too slow
(`QUOTER_TIMEOUT_MS`), unreachable, out of contract, or failing without a
usage. That call may have spent all the same, so it counts for a flat estimate,
`UNANSWERED_QUOTE_COST_USD` (0.002 by default, a few typical quotes).

- `DAILY_BUDGET_USD` absent, empty, `0` or invalid: no cap, and nothing is
  counted or written. Otherwise, once the total of the UTC day reaches it, a
  request gets `503 daily_budget_exhausted` before the quoter is called, with
  `Retry-After` the seconds left until midnight UTC; the UI says « le
  vidéoclub a épuisé son budget du jour ». The total starts again from zero
  with the next UTC day.
- **503, not 429**: 429 tells a client it sent too much, and the cure is on its
  side (`too_many_refusals`, `quote_in_progress`). Here every visitor is
  refused alike because the service has stopped spending: it is temporarily
  unavailable, and a client that backs off for its own sake changes nothing.
- **The app refuses to start live without a cap.** With `ENGINES=live` (which
  compose passes along) and no `DAILY_BUDGET_USD` above 0, `src/instrumentation.ts`
  prints one line naming both variables and exits with a non-zero code: live
  engines cost money on every quote, and this is the only public entry. (A
  throw alone would not stop the standalone server, so it exits.)
- The order of the checks: the rate per address, session, in-flight keys,
  strike block, body (`413`), the remembered refusal (free, still served and
  still a strike), then the address's share, the day's budget, and the quoter.
- The total is `{"day": "2026-10-04", "spent_usd": 1.25}` in `BUDGET_FILE`,
  rewritten for each answer by writing a sibling file, fsync, then `rename`
  over it: a restart, or a kill in the middle of a write, finds the previous
  total or the new one, never a half. Costs are summed in millionths of a dollar
  to keep the float drift out. Compose mounts the `web-data` volume on
  `/data` (owned by `node` in the image); without a volume, a recreated
  container starts from zero.
- A missing file counts as zero; an unreadable one counts as zero too, with an
  error in the log; a write that fails is logged and the total stays right in
  memory, the quote is still answered.
- The cap is soft by the quotes in flight: they were let through before the
  total reached the limit, and each adds its cost when it ends. The overshoot
  is at most what the quotes in flight cost (one per session or username,
  `IP_MAX_IN_FLIGHT` per address).
- One process, like the strike store: several web instances would each count
  their own spending and need a shared counter (Redis `INCRBYFLOAT` on a key
  per day) behind the same `BudgetStore` interface.

### Per-address share

One client address cannot spend the day's budget alone: `IP_DAILY_BUDGET_USD`,
by default a quarter of `DAILY_BUDGET_USD` (none when there is no global cap;
`0` turns it off; an explicit value works without a global cap too). What an
address's quotes cost, counted as the global total is (failures and the flat
estimate included), is kept per address for the UTC day, **in memory**: it
starts again at a restart, the file being the global ledger only. When it is
reached the address gets `429 ip_budget_exhausted`, until midnight UTC,
before the quoter is called and before the day's check, which is the less
specific message. The key is the address as the strike rule has it (IPv6 by its
/64); requests with no known address share one.

### Rate per address

`IP_RATE_LIMIT` quotes (20) within any `IP_RATE_WINDOW_S` (60 s) from one
client address, a sliding window of the times of its quotes
(`src/lib/rate.ts`): the next one is `429 rate_limited` with the wait. It is the
first check of the route, before the session, the strike leases and the body:
a flood costs one lookup. What is turned away is not counted, so a flood does
not push the wait further; `0` turns the limit off. In memory, bounded (the
least recently seen addresses go first, expired ones are swept as it is used,
no timer), like the strike store: several web instances would need a shared
counter behind the same interface.

### Client address

A route handler never sees the socket: the address comes from
`X-Forwarded-For`, and only the entries our side wrote are trusted.

- `TRUST_PROXY_HOPS=N` (N ≥ 1): the app sits behind N proxies of ours, each
  appending the address it was connected from. The client is the N-th entry
  from the right; the entries left of it came with the request, anyone can
  write them, and they are never read. This holds only if the app cannot be
  reached without going through those proxies.
- `TRUST_PROXY_HOPS=0` (default): no proxy. Next writes the connection's
  address into the header when the request has none, and that one is used.
  But Next keeps a header the client sent: without a proxy, a client that
  forges it chooses its address key. Exposed to the internet, the app goes
  behind a proxy that appends to `X-Forwarded-For`, with `TRUST_PROXY_HOPS`
  set. Locally (`docker compose`), the port is bound to `127.0.0.1`.

The key is an IPv4 address whole, and an IPv6 address by its /64 prefix
(`2001:db8:0:1::/64`), the block one subscriber usually holds: keying on the
whole address would let one client rotate through 2⁶⁴ of them. An IPv4-mapped
address (`::ffff:203.0.113.7`) counts as the IPv4 it carries; a port or
brackets some proxies add are dropped.
