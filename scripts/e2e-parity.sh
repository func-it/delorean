#!/usr/bin/env bash
# Holds the three quoters to the same bytes: starts each on its fake engines
# (Go :24799, TypeScript :24798, Python :24797), sends them the same requests,
# and compares answers, logs, commands and the traces they send a stand-in
# for Langfuse (e2e/parity). No key, no cost.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
go_bin="$work/delorean"
py_bin="$root/quoters/python/.venv/bin/delorean"
ts_main="$root/quoters/typescript/src/main.ts"

(cd "$root/quoters/go" && CGO_ENABLED=0 go build -o "$go_bin" ./cmd/delorean)
(cd "$root/quoters/python" && uv sync --locked --quiet && uv run --locked delorean tokenizer >/dev/null)

pids=""
trap 'for p in $pids; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true' EXIT

start() { # name port command...
  local name=$1 port=$2
  shift 2
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    echo "port $port is taken: another run of the suites (task e2e, task e2e:parity) holds it" >&2
    exit 1
  fi
  env -u OPENROUTER_API_KEY -u RUN_LIVE -u LANGFUSE_HOST -u LANGFUSE_TRACING_ENVIRONMENT -u LANGFUSE_RELEASE \
    ENGINES=fake PORT="$port" LANGFUSE_PUBLIC_KEY="pk-$name" LANGFUSE_SECRET_KEY=sk LANGFUSE_BASE_URL="$capture" \
    "$@" >"$work/$name.log" 2>&1 &
  local pid=$!
  pids="$pids $pid"
  for _ in $(seq 1 100); do
    curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && return
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "the $name quoter stopped at startup:" >&2
      cat "$work/$name.log" >&2
      exit 1
    fi
    sleep 0.2
  done
  echo "the $name quoter did not answer on :$port" >&2
  exit 1
}

# a stand-in for Langfuse, which keeps every span and score the quoters send
(cd "$root/e2e" && exec node src/capture.ts) >"$work/capture.port" 2>"$work/capture.log" &
pids="$pids $!"
for _ in $(seq 1 50); do
  capture_port="$(head -n1 "$work/capture.port" 2>/dev/null || true)"
  [ -n "$capture_port" ] && break
  sleep 0.1
done
[ -n "$capture_port" ] || { echo "the Langfuse stand-in did not start:" >&2; cat "$work/capture.log" >&2; exit 1; }
capture="http://127.0.0.1:$capture_port"

start go 24799 "$go_bin" serve
start typescript 24798 node "$ts_main"
start python 24797 "$py_bin" serve

cd "$root/e2e"
PARITY_URLS="{\"go\":\"http://127.0.0.1:24799\",\"typescript\":\"http://127.0.0.1:24798\",\"python\":\"http://127.0.0.1:24797\"}" \
PARITY_LOGS="{\"go\":\"$work/go.log\",\"typescript\":\"$work/typescript.log\",\"python\":\"$work/python.log\"}" \
PARITY_COMMANDS="{\"go\":[\"$go_bin\"],\"typescript\":[\"node\",\"$ts_main\"],\"python\":[\"$py_bin\"]}" \
PARITY_SPARE_PORT=24796 \
PARITY_CAPTURE="$capture" \
  npm run --silent parity -- "$@"
