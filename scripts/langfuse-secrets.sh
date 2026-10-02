#!/usr/bin/env bash
# Fills the root .env with what the local Langfuse needs (deploy/langfuse):
# its passwords and keys, the project's API keys, and where it answers. A value
# already set is never replaced; .env is created from .env.example if absent.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env="$root/.env"
[ -f "$env" ] || cp "$root/.env.example" "$env"

# keep sets NAME=VALUE unless NAME already has a value.
keep() {
  if grep -qE "^$1=.+" "$env"; then return; fi
  if grep -qE "^$1=" "$env"; then
    NAME="$1" VALUE="$2" perl -pi -e 's/^\Q$ENV{NAME}\E=.*/$ENV{NAME}=$ENV{VALUE}/' "$env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$env"
  fi
}

hex() { openssl rand -hex "$1"; }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

keep SESSION_SECRET "$(hex 32)"
keep LANGFUSE_PUBLIC_KEY "pk-lf-$(uuid)"
keep LANGFUSE_SECRET_KEY "sk-lf-$(uuid)"
keep LANGFUSE_BASE_URL "http://localhost:24794"
keep LANGFUSE_DOCKER_BASE_URL "http://host.docker.internal:24794"
keep LF_DB_PASSWORD "$(hex 24)"
keep LF_CLICKHOUSE_PASSWORD "$(hex 24)"
keep LF_REDIS_AUTH "$(hex 24)"
keep LF_MINIO_PASSWORD "$(hex 24)"
keep LF_SALT "$(hex 24)"
keep LF_ENCRYPTION_KEY "$(hex 32)"
keep LF_NEXTAUTH_SECRET "$(hex 32)"
keep LF_USER_PASSWORD "$(hex 12)"

echo "Langfuse secrets are in .env — UI http://localhost:24794, account admin@delorean.local, password LF_USER_PASSWORD."
