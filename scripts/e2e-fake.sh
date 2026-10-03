#!/usr/bin/env bash
# Runs the end-to-end suite against one quoter on its fake engines: no key,
# no cost. The quoter is built, started on a free port, and stopped on exit.
#   scripts/e2e-fake.sh            # the Go quoter
#   PORT=9081 scripts/e2e-fake.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${PORT:-24799}"
bin="$(mktemp -d)/delorean"

(cd "$root/quoters/go" && CGO_ENABLED=0 go build -o "$bin" ./cmd/delorean)

env -u OPENROUTER_API_KEY ENGINES=fake PORT="$port" "$bin" serve >"$bin.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "the quoter stopped at startup:" >&2
    cat "$bin.log" >&2
    exit 1
  fi
  sleep 0.2
done

cd "$root/e2e"
BASE_URL="http://127.0.0.1:$port" npm run --silent e2e
