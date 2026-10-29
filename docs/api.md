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

The prompt includes today's date and the next 21 days with weekdays (India time): Haiku got
"this weekend" wrong by a day without it.

`GET /me` also returns the user's chat defaults (`defaultMode`, `defaultLimitUnits`) and whether
setup is done (`onboarded`); `PATCH /me` changes name, city, defaults, or finishes setup. New
chats start with the user's defaults.

Live check (2026-10-30, Docker Postgres, real Haiku and Arkiv): a general question got a direct
answer; "a quiet hotel for 2 nights, who can book it?" called `find_agents`, showed an agents card
and replied that StayWise fits at 0.04 USDC, within the chat's 0.30 limit, and that booking from
chat comes next. Two Arkiv agents both called StayWise, so cards add a short address to tell
them apart.

## Hiring from chat

The concierge can now hire and pay agents. Money only moves through `apps/api/src/hiring`, which
enforces the rules in code; the model can ask for a hire, it can't skip a check.

1. **Quotes are free.** `agent_input` reads what the agents need (their published JSON Schema),
   `get_quotes` asks every listed agent for the skill and shows a quotes card. Quotes get short
   refs (`q1`, `q2`) and live about 3 minutes.
2. **A spending limit per chat, on Hedera.** Before the first payment the chat needs a
   MandateRegistry mandate whose agent is the concierge and whose payees are the quoting agents.
   The limit card asks for what's left of the chat's limit (never the whole limit again).
   - Wallet users create it in MetaMask (allow USDC, then create the mandate) and send its id to
     `POST /chats/:id/mandate`. The API checks on-chain that they own it, the concierge is its
     agent, it pays in USDC, it's live, and it allows every agent on the card.
   - Demo users approve it with the shared test wallet (`{ demo: true }`), never wallet users.
3. **"Ask first" chats** need an approval card per payment. Its buttons send
   `Approve <code>` / `Decline <code>`; the server reads the code, and one approval pays once.
4. **Paying** goes through x402 under the mandate (the concierge's key signs, the user's
   account pays), then the job, receipt and rating are written to Arkiv and the hire is saved.

Each turn the concierge is told what was already hired in the chat, from the `hires` table
rather than its memory, so it doesn't book twice. Turns keep running when the browser
disconnects (an agent may already be paid), the stream sends a ping every 10 s, and the web app
reloads the saved reply if the stream drops.

`GET /chats/:id/mandate` returns the chat's current mandate and what's left on it.

Run the market for hiring: `pnpm --filter @eth/agents serve` (facilitator plus SkyHop, AirNest,
StayWise and PriceGuard).

## Tasks and wallet

- `GET /tasks`: every hire in the user's chats, newest first, with result, fee, mandate and proof.
- `GET /wallet`: the user's Hedera account (wallet users: looked up from their address; demo
  users: the shared demo wallet), balances from the mirror node, each chat limit read live from
  the contract (budget, spent, revoked, expiry), and all fees paid.
- `POST /wallet/limits/:mandateId/revoke`: cancels a demo limit with the demo wallet. Wallet users
  own their limits and cancel them in MetaMask (the contract lets only the owner or its agent
  revoke). Another user's limit is "not found".

## Public spending log (Hedera HCS)

Web2 analogy: an append-only audit log that a third party hosts, numbers and timestamps, and
nobody (us included) can edit or delete.

Everything goes to one HCS topic, `SPEND_LOG_TOPIC_ID`, as JSON messages:

| `kind` | Written by | When |
|---|---|---|
| `x402.settled` | the facilitator | every agent payment it settles (mandate, payer, payee, amount, transaction) |
| `agentnet.mandate.created` | the API | a chat limit is set up (demo wallet or MetaMask) |
| `agentnet.mandate.revoked` | the API | a demo limit is cancelled |
| `agentnet.hired` | the API | an agent was hired and paid (skill, agent, fee, payment transaction, Arkiv job) |

The operator account holds the topic's submit key. Writes are best-effort: the hire is saved
first and a failed log write never undoes it. The entry's number is stored as `logSeq` on hires
and limits; `/tasks`, `/wallet` and the hired card return it with `logTopic`.

- `GET /spend-log` (no sign-in): the latest 100 entries read back from the mirror node, newest
  first, plus `names` (agents from their Arkiv profiles, by Hedera account and EVM address).

`pnpm --filter @eth/api dev` loads the repo's `.env` if it exists (Hedera keys, Claude key).

