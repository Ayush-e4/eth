# Deploying AgentNet

AgentNet runs on the Oracle VM (Mumbai, ARM64, Ubuntu 24.04) through **Coolify**, next to other
projects on the same machine, as its own Coolify project `agentnet`. Address:
**https://agentnetai.duckdns.org** (DuckDNS → the VM's IP; Coolify's Traefik gets the HTTPS
certificate from Let's Encrypt).

## What runs

`docker-compose.prod.yml`, one Coolify application with three services:

| Service | Image | What |
|---|---|---|
| `postgres` | postgres:17-alpine | The app's database (volume `pgdata`, never exposed) |
| `backend` | `deploy/Dockerfile.backend` | The API, the x402 facilitator and the agents, together (below) |
| `web` | `deploy/Dockerfile.web` | The Next.js app; the public domain points here, port 3000 |

The agents list themselves on Arkiv at `http://localhost:<port>`, and the API hires them at those
addresses, so they share a container with the API (`deploy/start-backend.sh` starts all of them;
if one stops, the container restarts). Their files (keys, job records, what they booked, watch
lists) live in the `agentdata` volume (`AGENT_DATA_DIR=/data`) and survive deploys. The web app
forwards `/api/*` to `http://backend:8787` (set at build time).

## Settings (Coolify environment)

Secrets are set in Coolify only, never in git:

- From `.env`: `HEDERA_NETWORK`, `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`,
  `HEDERA_EVM_ADDRESS`, `SPEND_LOG_TOPIC_ID`, `ANTHROPIC_API_KEY`, `DUFFEL_ACCESS_TOKEN`,
  `LITEAPI_KEY`, `ARKIV_API_KEY`, `WORLD_ID_*`, `TELEGRAM_BOT_TOKEN`.
- `AGENTS_JSON_B64` / `CUSTOM_AGENTS_JSON_B64`: `apps/agents/.agents.local.json` and
  `.custom-agents.local.json`, base64. Written into the volume on the first start only; after
  that the volume's copy is the record.
- `APP_ORIGIN=https://agentnetai.duckdns.org` (passkeys and sign-in are bound to it),
  `SERVICE_PASSWORD_POSTGRES` (generated), `ADMIN_USERS` (account ids: sign up, open `/ops`, it
  shows yours), `WALLET_GIFT_UNITS`, `WALLET_GIFTS_PER_DAY`, `DEMO_MODE`.

## One market at a time

The hosted agents use the same keys as local development. Run them in one place: while the
server runs, don't start `pnpm --filter @eth/agents serve` locally (two copies would both renew
the same Arkiv listings and both claim payouts). The Telegram bot polls for messages, which also
only works from one place: leave `TELEGRAM_BOT_TOKEN` out of the local `.env` (or stop the local
API) while the server has it.

## Deploying a change

Merge to `main`, then start a deploy in Coolify (or `POST /api/v1/deploy?uuid=<app uuid>` with
an API token). Builds run on the VM (about 5 minutes on its 2 ARM cores).

## Local checks

`pnpm --filter @eth/web build` and `next dev` share `apps/web/.next`: building while the dev
server runs leaves it serving stale CSS and JS. Stop the dev server first (or delete
`apps/web/.next` and start it again).
