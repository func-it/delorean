#!/usr/bin/env bash
# Runs the end-to-end suite against the Python quoter on its fake engines:
# no key, no cost. The quoter is started on its own port, and stopped on
# exit.
#   quoters/python/scripts/e2e-fake.sh
#   PORT=9082 quoters/python/scripts/e2e-fake.sh
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
port="${PORT:-24797}"
log="$(mktemp)"

(cd "$here" && uv sync --locked --quiet && uv run --locked delorean tokenizer >/dev/null)

env -u OPENROUTER_API_KEY ENGINES=fake PORT="$port" "$here/.venv/bin/delorean" serve >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "the quoter stopped at startup:" >&2
    cat "$log" >&2
    exit 1
  fi
  sleep 0.2
done

cd "$root/e2e"
BASE_URL="http://127.0.0.1:$port" npm run --silent e2e
