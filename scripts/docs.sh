#!/usr/bin/env bash
# Serves the documentation site on http://localhost:24795 (PORT to change it),
# without Docker. The pages and the repository files they read are linked into
# a temporary root, so edits show on reload and nothing else is served.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${PORT:-24795}"

if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
  if curl -fsS "http://127.0.0.1:$port/" | grep -q "Delorean docs"; then
    echo "The documentation is already served on http://localhost:$port (the docker compose service docs)."
    exit 0
  fi
  echo "Port $port is taken by another server. Pick another one: PORT=4001 task docs" >&2
  exit 1
fi

site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT

for f in "$root"/docs/site/*; do ln -s "$f" "$site/"; done
mkdir "$site/content"
ln -s "$root/README.md" "$site/content/README.md"
ln -s "$root/docs/architecture.md" "$site/content/architecture.md"
ln -s "$root/docs/testing.md" "$site/content/testing.md"
ln -s "$root/api/openapi.yaml" "$site/content/openapi.yaml"

echo "Documentation on http://localhost:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$site"
