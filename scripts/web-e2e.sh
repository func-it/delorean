#!/usr/bin/env bash
# Runs the web app's Playwright suite (web/e2e) in a real browser against the
# whole stack on fake engines: no key, no cost. The stack is a compose
# project of its own, with no port on the host (deploy/web-e2e/compose.yml),
# so it never meets a stack already running; Playwright runs in its image, on
# the project's network. Everything is taken down on exit.
#   scripts/web-e2e.sh
#   scripts/web-e2e.sh --project mobile     # arguments go to playwright test
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="${WEB_E2E_PROJECT:-delorean-web-e2e}"
# the version of @playwright/test in web/package-lock.json
playwright="mcr.microsoft.com/playwright:v1.56.0-noble"

compose() {
  env -u OPENROUTER_API_KEY ENGINES=fake SESSION_SECRET=web-e2e-only-secret-of-32-characters \
    docker compose -p "$project" -f "$root/compose.yml" -f "$root/deploy/web-e2e/compose.yml" \
    --env-file /dev/null "$@"
}
trap 'compose down --volumes --remove-orphans >/dev/null 2>&1 || true' EXIT

compose up --build --detach --quiet-pull web

run() {
  docker run --rm --network "${project}_default" --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI \
    -e BASE_URL=http://web:24790 -v "$root/web:/web" -w /web "$playwright" "$@"
}
# the stack answers once the web app and its quoter are up
run sh -c 'for i in $(seq 1 120); do node -e "fetch(process.env.BASE_URL + \"/\").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && exit 0; sleep 1; done; echo "the stack did not answer" >&2; exit 1'
run sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx playwright test "$@"' playwright "$@"
