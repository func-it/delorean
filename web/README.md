# web: the interface and the BFF

Next.js (App Router): the page where you write your cart, and the BFF (route
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
example the Go quoter with `ENGINES=fake`.

Docker image (`standalone` output, non-root user, port 24790):

```sh
docker build -t delorean-web .
docker run -p 24790:24790 -e SESSION_SECRET=… -e QUOTER_URL=http://go:24791 delorean-web
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_SECRET` | development secret, with a warning | seals the session cookie; at least 32 characters, **required in production** |
| `QUOTERS` | — | quoters as JSON, name → URL: `{"go":"http://localhost:24791","python":"http://localhost:24792"}`; the first one is the default; with two or more, the header shows a selector |
| `QUOTER_URL` | `http://localhost:24791` | a single quoter, when `QUOTERS` is not set |
| `SESSION_COOKIE_SECURE` | `true` in production | `false` when the app is served over plain HTTP (`docker compose` locally): some browsers reject a `Secure` cookie received over HTTP, even from localhost |
| `QUOTER_TIMEOUT_MS` | `35000` | maximum wait for a quoter (a little more than its 30 s) |
| `STRIKE_LIMIT` | `3` | injection refusals that block a session or a username ([strike rule](#strike-rule)) |
| `IP_STRIKE_LIMIT` | `10` | injection refusals that block a client address, which a carrier's NAT may share between many customers |
| `IP_MAX_IN_FLIGHT` | `4` | quotes in flight at once from one client address (a session or a username: one) |
| `STRIKE_WINDOW_S` | `900` | the window those refusals are counted in, in seconds |
| `STRIKE_BLOCK_S` | `900` | how long a block lasts, in seconds |
| `REFUSAL_MEMORY_S` | `21600` | how long a text refused as an injection is answered from memory, in seconds |
| `TRUST_PROXY_HOPS` | `0` | how many proxies of ours stand in front of the app, each appending to `X-Forwarded-For` ([client address](#client-address)) |

The browser picks a quoter by its **name**, checked against this list, never
by URL.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | development server |
| `npm run build`, `npm start` | production build (`.next/standalone`, the one the image uses), then server; `start` reads `.env.local` if it exists |
| `npm test` | Vitest: BFF and libraries (Node), components (jsdom) |
| `npm run lint`, `npm run typecheck` | ESLint, `tsc --noEmit` |
| `npm run generate` | regenerates `src/generated/api.d.ts` from `../api/openapi.yaml` (the file is committed: the Docker build only needs `web/`) |

## Session

**Identification, not authentication**: a username, without a password, used
to group traces by user and by visit. The cookie (`httpOnly`, `SameSite=Lax`,
`Secure` in production) is encrypted and signed by iron-session; it contains
`{username, sessionId, createdAt}`.

## BFF

| Route | Quoter | Notes |
|---|---|---|
| `POST /api/quotes` | `POST /v1/quotes` | body `{cart, quoter?}`; the quoter's status and JSON are passed through unchanged, after the [strike rule](#strike-rule) |
| `GET /api/catalog?quoter=` | `GET /v1/catalog` | revalidated every 60 s |

On top of the contract's codes, the BFF adds its own, in the same format
(RFC 9457):

- `no_session` (401): no valid session;
- `too_many_refusals` (429): the session, the username or the client address
  is blocked by the strike rule; `Retry-After` and `retry_after_s` say for how
  many more seconds;
- `quote_in_progress` (429): a quote is already in flight for the session or
  the username, or `IP_MAX_IN_FLIGHT` for the client address;
  `Retry-After: 1`;
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
- the refused text is remembered for `REFUSAL_MEMORY_S`, under the SHA-256 of
  the text trimmed with CRLF as LF: sent again, by anyone, it gets the same
  `422` at once, with `"remembered": true` and without the original call's
  `usage`. It counts as a strike all the same. Resending a text cannot draw
  the guard again;
- no other code counts: `invalid_request`, `no_film` and the rest never block;
- quotes in flight: one per session and per username, `IP_MAX_IN_FLIGHT` (4)
  per address; a request on a full key gets `429 quote_in_progress`
  (`Retry-After: 1`) at once. The keys are taken all or none before the block is checked, and
  released in a `finally`, whatever the answer. Without this, requests sent in
  parallel would all reach the guard before the first refusal came back.

The UI explains all three in French: the wait in minutes, "Ce panier a déjà
été refusé", and "Un devis est déjà en cours".

The session and the username are the visitor's choice (identification, not
authentication), so the address is the key a client cannot change by logging
in again. The memory, which ignores who sends the text, holds whatever the
keys.

An address gets looser limits than a visitor because a carrier's NAT puts many
mobile customers behind one IPv4: ten refusals among them before a block, four
quotes at once before a `quote_in_progress`. The price, on purpose: an attacker
gets that much room per address, and still only three refusals per session
and username, which cost a new login each.

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
