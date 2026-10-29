# API server

`apps/api` is a Hono server backed by Postgres. It is what the web app talks to.

## Run it locally

```bash
pnpm db:up                          # Postgres 17 in Docker on 127.0.0.1:54329
pnpm --filter @eth/api dev          # http://localhost:8787, applies migrations on start
pnpm db:down                        # stop the database (data stays in the Docker volume)
```

Port 54329 is deliberate, so the container never clashes with a Postgres you already run on 5432.
Tests don't need Docker: they run against PGlite, an in-memory Postgres, with the same migrations.

Change the schema in `src/db/schema.ts`, then `pnpm --filter @eth/api db:generate` writes the
SQL migration to `apps/api/drizzle/`. Commit it with the schema change.

## Sign-in (Sign-In with Ethereum)

Web2 analogy: a password login where the "password" is a signature only your wallet can make.

1. `GET /auth/nonce` gives a one-time code, valid 10 minutes.
2. The browser builds a sign-in message with that code (domain, `APP_ORIGIN`, chain 296 =
   Hedera testnet) and MetaMask signs it. Signing is free and sends no transaction.
3. `POST /auth/verify {message, signature}` checks the message is for this site and network,
   that the signature matches the account, and uses the code up in the same database statement
   so it can't be replayed. It then sets an httpOnly `eth_session` cookie (7 days).
4. `GET /me` returns the signed-in user and their roles. `POST /auth/logout` ends the session.

Only a SHA-256 hash of the session token is stored, so a database leak doesn't hand out logins.
Writes from any origin other than `APP_ORIGIN` are refused, and cookies are `SameSite=Lax`.

`POST /auth/demo` ("Try the demo") creates a fresh demo user with no wallet. Turn it off with
`DEMO_MODE=off`.

## Roles

| Role | Who | How it's decided |
|---|---|---|
| user | everyone signed in | default |
| admin | wallets in `ADMIN_WALLETS` | server setting, so nobody can make themselves admin |
| builder | people who own an agent | added when agents are stored in the database |

## Chats and the concierge

All chat routes need a session, and every query is scoped to the signed-in user: another
user's chat id is simply "not found".

| Route | What it does |
|---|---|
| `GET /chats` | your chats, newest first |
| `POST /chats` | start a chat (titled from its first message) |
| `GET /chats/:id` | the chat and its messages, each with any cards |
| `PATCH /chats/:id` | `title`, `mode` (`auto` or `ask`), `limitUnits` (agent-fee limit, max 5 USDC) |
| `DELETE /chats/:id` | delete it and its messages |
| `POST /chats/:id/messages` | `{ text }`; the reply streams back as Server-Sent Events |

The stream is a sequence of events (types in `packages/shared/src/chat.ts`): `text` deltas,
`status` ("Looking at the market"), `card`, then `done` with the saved message id, or `error`.
Cards are data the web app draws, not prose: `agents` (who on the market can do it, and their
fee) and `options` (2 to 5 choices; tapping one sends its reply).

The concierge is Claude Haiku on the SDK's Tool Runner, streaming. Its tools only read:
`find_agents` (the market from Arkiv, joined to live listings) and `show_options`. Hiring and
paying from chat is not switched on yet; the concierge says so rather than pretending. Listing
text comes from anyone, so the system prompt treats it as data, never instructions. A turn is
capped at 5 tool rounds and 4,000 output tokens, and sees the last 30 messages.

Without `ANTHROPIC_API_KEY` the server still runs; sending a message returns 503.

Live check (2026-10-30, Docker Postgres, real Haiku and Arkiv): a general question got a direct
answer; "a quiet hotel for 2 nights, who can book it?" called `find_agents`, showed an agents card
and replied that StayWise fits at 0.04 USDC, within the chat's 0.30 limit, and that booking from
chat comes next. Two Arkiv agents both called StayWise, so cards add a short address to tell
them apart.
