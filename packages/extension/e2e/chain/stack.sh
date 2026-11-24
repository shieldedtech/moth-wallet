#!/usr/bin/env bash
# Runs docker compose for the chain-backed E2E stack with fresh credentials.
#
# The indexer needs a secret and storage passwords. They protect nothing beyond
# a disposable container, but a literal in compose.yml is a committed secret all
# the same, so each invocation generates its own and they exist only in the
# containers' environment.
#
#   packages/extension/e2e/chain/stack.sh up -d --wait
#   packages/extension/e2e/chain/stack.sh logs --tail=300
#   packages/extension/e2e/chain/stack.sh down -v
set -euo pipefail

INDEXER_SECRET="$(openssl rand -hex 32)"
INDEXER_PASSWORD="$(openssl rand -hex 16)"
export INDEXER_SECRET INDEXER_PASSWORD

exec docker compose -f "$(dirname "$0")/compose.yml" "$@"
