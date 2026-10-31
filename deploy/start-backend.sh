#!/usr/bin/env bash
# The API, the x402 facilitator and the agents, in one container: agents list themselves on
# Arkiv at localhost addresses, which the API reaches here. If any process stops, the container
# stops and Docker starts it again.
set -euo pipefail
: "${AGENT_DATA_DIR:=/data}"
mkdir -p "$AGENT_DATA_DIR"
chmod 700 "$AGENT_DATA_DIR"

# The agents' keys come in as base64 secrets the first time; after that the file on the volume
# is the record (agents add to it, e.g. their ERC-8004 ids).
seed() {
  local file="$AGENT_DATA_DIR/$1" value="${2:-}"
  if [ -n "$value" ] && [ ! -s "$file" ]; then
    printf '%s' "$value" | base64 -d >"$file"
    chmod 600 "$file"
  fi
}
seed .agents.local.json "${AGENTS_JSON_B64:-}"
seed .custom-agents.local.json "${CUSTOM_AGENTS_JSON_B64:-}"

cd /app/apps/agents
pnpm exec tsx scripts/serve.ts &
pnpm exec tsx scripts/kit/run-agent.ts packpal &
cd /app/apps/api
pnpm exec tsx src/index.ts &

wait -n
echo "a backend process stopped; restarting the container" >&2
exit 1
