# e2e: end-to-end suite and system bench

A black box: the suite and the bench only talk to the HTTP contract
(`api/openapi.yaml`). They apply to all three backends, Go, Python and
TypeScript, without a single line specific to any of them.

## What the suite guarantees

- **The contract**: every response is validated against its schema
  (`Quote`, `Problem`, `Health`, `Catalog`, JSON Schema 2020-12 read from the
  YAML) and its media type (`application/json`, `application/problem+json`).
- **The catalog rules**: €15 per volume, €20 for any other film, -10% at
  2 distinct volumes, -20% at 3.
- **Malformed requests**: invalid JSON, `cart` missing or of another type,
  unknown property, invalid `X-User-Id` (400), body too large (413, and the
  exact limit passes), empty or too long cart (422).
- **Correlation and usage**: `X-Request-Id` generated or echoed back,
  rejections included; `usage` on every 200 and 422, stages in pipeline order
  up to the one that rejects, implementation and engines matching `/healthz`.
- **The invariants of every quote**: subtotal = Σ lines, line = unit price ×
  quantity, distinct volumes and discount tier, base = Σ saga lines,
  total = subtotal − discount, judge score ≥ threshold, no line above
  `limits.max_copies_per_title`.
- **The fake engines** (`ENGINES=fake`): outage (502), unfaithful reading,
  injection, cart without letters, cart without a film, copy limit per title
  (the limit passes, one more is rejected).
- **The cases** in `cases/quote`: status, `total_cents` and quantities per
  film, or the rejection code.

## Running the suite

```sh
npm ci
npm run e2e                                   # backend on http://localhost:24791
BASE_URL=http://localhost:24792 npm run e2e    # python
BASE_URL=http://localhost:24793 npm run e2e    # typescript
```

The suite first reads `GET /healthz`. Backend in `fake` mode: contract + cases
tagged `fake`, nothing is billed. Backend in `live` mode: every request costs
OpenRouter credits, so the suite refuses to start without `RUN_LIVE=1`, then
runs every case:

```sh
RUN_LIVE=1 BASE_URL=http://localhost:24791 npm run e2e
```

## System bench

```sh
npm run bench -- --base-url http://localhost:24791 --runs 3 [--tag injection] [--concurrency 4]
npm run bench:compare -- ../reports/go-live-….json ../reports/python-live-….json
```

The bench announces the number of requests, then runs each case N times (in
`live` mode, only with `RUN_LIVE=1`). It measures the accuracy of prices,
rejections and per-film quantities, the error rate (no response, 5xx, response
outside the contract), p50 / p90 / max latency, and cost per cart and per
stage. It writes `reports/<implementation>-<engines>-<timestamp>.json` and
`.md`; `bench:compare` puts reports side by side.

With `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`, the
bench also pushes its results: the cases become the `quote` dataset (items
`quote:<id>`), each run an experiment, with a `correct` score per item.
Pushing the same report twice changes nothing.

## Adding a case

A file `cases/quote/<id>.json`, with the `id` equal to the file name:

```json
{
  "id": "quantite-prefixe",
  "note": "L'erreur que ce cas garde, et le calcul (15 × 2 = 30 €).",
  "tags": ["quantite", "fake"],
  "input": { "cart": "2 x Back to the Future 2" },
  "expect": { "status": 200, "total_cents": 3000, "films": { "bttf_2": 2 } }
}
```

or `"expect": { "status": 422, "code": "injection" }` for a rejection. The
`fake` tag is reserved for cases that the fake engines pass deterministically
(see `docs/architecture.md`). `npm test` checks the shape of each case and
that its total follows from its `films`.

## The harness itself

```sh
npm test            # harness tests, against an embedded fake backend
npm run typecheck
npm run lint
npm run format      # Prettier; format:check in CI
npm run generate    # after a change to api/openapi.yaml
```

`npm test` also runs the suite and the bench against
`test/support/stub-backend.ts`, a minimal implementation of the contract with
fake engines, and checks that the suite fails against a backend that gets the
total wrong. It also fails if `src/generated/openapi.ts` no longer matches the
contract.
