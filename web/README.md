# web: the interface and the BFF

Next.js (App Router): the page where you write your cart, and the BFF (route
handlers) that holds the session, hides the backend URLs from the browser and
forwards `X-User-Id`, `X-Session-Id` and `X-Request-Id`. See
[`docs/architecture.md`](../docs/architecture.md).

## Running

```sh
npm ci
cp .env.example .env.local   # then adjust
npm run dev                  # http://localhost:24790
```

You need a backend that responds (`http://localhost:24791` by default), for
example the Go backend with `ENGINES=fake`.

Docker image (`standalone` output, non-root user, port 24790):

```sh
docker build -t delorean-web .
docker run -p 24790:24790 -e SESSION_SECRET=… -e BACKEND_URL=http://go:24791 delorean-web
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_SECRET` | development secret, with a warning | seals the session cookie; at least 32 characters, **required in production** |
| `BACKENDS` | — | backends as JSON, name → URL: `{"go":"http://localhost:24791","python":"http://localhost:24792"}`; the first one is the default; with two or more, the header shows a selector |
| `BACKEND_URL` | `http://localhost:24791` | a single backend, when `BACKENDS` is not set |
| `SESSION_COOKIE_SECURE` | `true` in production | `false` when the app is served over plain HTTP (`docker compose` locally): some browsers reject a `Secure` cookie received over HTTP, even from localhost |
| `BACKEND_TIMEOUT_MS` | `35000` | maximum wait for a backend (a little more than its 30 s) |

The browser picks a backend by its **name**, checked against this list, never
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

| Route | Backend | Notes |
|---|---|---|
| `POST /api/quotes` | `POST /v1/quotes` | body `{cart, backend?}`; the backend's status and JSON are passed through unchanged |
| `GET /api/catalog?backend=` | `GET /v1/catalog` | revalidated every 60 s |

On top of the contract's codes, the BFF adds its own, in the same format
(RFC 9457):

- `no_session` (401): no valid session;
- `backend_unavailable` (502): the backend is unreachable, too slow, or
  answers outside the contract.
