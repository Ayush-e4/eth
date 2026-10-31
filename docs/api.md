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

**Agents that hire agents.** A planner's quote (e.g. TripMint, skill `trips`) names who it will
hire and the budget for them.
- The limit card then lists the planner and those agents, and needs room for the fee plus that
  budget. An approval card says how much goes to which agents.
- At hire time the API carves a sub-mandate from the chat's mandate. The concierge signs it,
  the demo wallet pays the gas, and the API logs it as `agentnet.mandate.delegated`. It is
  passed to the planner as `delegation`.
- The planner's own hires are saved under the sub-mandate, so Tasks, Wallet and the chat's
  limit count all three payments. The hired card shows them nested.
- If the planner fails after the slice is granted, the slice stays reserved until it expires
  (at most an hour). The contract doesn't hand unspent slices back.

`GET /chats/:id/mandate` returns the chat's current mandate and what's left on it.

Run the market for hiring: `pnpm --filter @eth/agents serve` (facilitator plus SkyHop, AirNest,
StayWise, PriceGuard and TripMint).

## Open tasks with bids (Arkiv)

The concierge can post a job to the whole market instead of asking known agents: `post_task`
writes a `task` record on Arkiv (public; no personal data in its `input`), owned by the
concierge's wallet, open 2–30 minutes, fee capped at one payment (0.10 USDC). Agents watching the
board bid by themselves (a signed, expiring `quote` for that task).

- `check_bids` (tool) and `GET /chats/:id/open-tasks/:task/bids` (owner only, for the live card)
  read the bids from Arkiv, ranked by total cost, under the same short refs as quotes, so
  `hire_agent`, limits and approvals work unchanged. Reads are cached 8 s.
- After a hire from a bid, the API writes a read-only `claim` and sets the task to `awarded`.
- `GET /open-tasks` (public): every live task on Arkiv with its bids and award, cached 15 s.

Set `ARKIV_API_KEY` (from hub.arkiv.network) on busy setups: the keyless query budget is small.

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
| `agentnet.mandate.delegated` | the API | a slice of a limit is granted to an agent that hires agents |
| `agentnet.hired` | the API | an agent was hired and paid (skill, agent, fee, payment transaction, Arkiv job) |

The operator account holds the topic's submit key. Writes are best-effort: the hire is saved
first and a failed log write never undoes it. The entry's number is stored as `logSeq` on hires
and limits; `/tasks`, `/wallet` and the hired card return it with `logTopic`.

- `GET /spend-log` (no sign-in): the latest 100 entries read back from the mirror node, newest
  first, plus `names` (agents from their Arkiv profiles, by Hedera account and EVM address).

`pnpm --filter @eth/api dev` loads the repo's `.env` if it exists (Hedera keys, Claude key).

## Restarts

Nothing a chat is in the middle of lives only in memory. A restart (a deploy, a crash, `tsx watch`)
picks up where it left off:

| What | Kept in | After a restart |
|---|---|---|
| Quote refs (q1, q2…) | `quote_refs` (bigints as `{"$bigint": "…"}`) | still hireable until they expire; numbering keeps counting up |
| "Ask first" approvals | `approvals` | the card can still be approved; taking one is a single `DELETE … RETURNING`, so it pays once |
| World ID checks | `human_checks` (device code stays server-side) | waiting checks resume polling; ones that ran out are marked expired |
| Open tasks | `open_tasks` | bids, refs and the award carry on; the award is a conditional update, so it's recorded once |
| Hires being paid | `pending_hires` (written before paying) | followed to the end: read back from the agent (`GET /jobs`, signed by the concierge), recorded, and posted to the chat with its card, or with the refund |
| Undo-window payments | `scheduled_payments` | run when their window ends; card status from the facilitator, or Hedera's mirror if it restarted (it adopts pending schedules, so Cancel still works) |
| A turn in progress | (replies are saved when a turn ends) | the chat gets a short note that it was cut off, so the page stops waiting; the hire's result follows as its own message |

Only caches stay in memory (bid reads, INR rates). Startup work is in `src/index.ts`.

## Demo accounts and their allowances

"Try the demo" signs in without a wallet; every demo account shares one test wallet (the
operator), which pays agent fees, the network fees of each new spending limit, and nobody's
Claude tokens but ours. Since anyone can open a demo account in one click, per-account limits
alone are easy to dodge, so the shared wallet also has a daily total (`src/demo/quotas.ts`):

| Allowance (rolling 24 h) | Default | Setting |
|---|---|---|
| Messages per demo account | 40 | `DEMO_MESSAGES_PER_DAY` |
| Paid hires per demo account | 5 | `DEMO_HIRES_PER_DAY` |
| Spending limits per demo account | 3 | `DEMO_LIMITS_PER_DAY` |
| Spending limits, all demo accounts | 40 | `DEMO_LIMITS_TOTAL_PER_DAY` |
| Agent fees, all demo accounts | 3 USDC | `DEMO_FEES_TOTAL_PER_DAY_USDC` |

Over an allowance, the message is refused (429) before it reaches Claude, the limit isn't
created, and the hire is refused before anything is paid, each with a line saying why and that
signing in with MetaMask (your own test wallet) has no such limits. The Wallet page shows a demo
account what it has left today (`GET /demo/quota`).

## Status (`GET /status`, public page `/status`)

Is everything up? The API pings the payment service (facilitator) and every agent listed on the
market, checks Hedera's mirror and Arkiv, and reads the shared demo wallet's balances, today's
demo spending and the latest payment (`src/status/check.ts`, cached 30 s). Nothing private is in
it: balances and payments are public on Hedera anyway. No sign-in needed.

- **Low balance**: under 1 test USDC or 20 HBAR the page warns, with where to top up (the faucets
  need a CAPTCHA, so topping up stays a manual, one-minute job).
- **Before it runs dry**: under 0.50 test USDC (plus the fee), demo hires are refused with a plain
  reason instead of failing mid-payment. If the balance can't be read, nothing is blocked.

