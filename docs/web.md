# Web app

`apps/web` is the AgentNet console (Next.js 16, Tailwind 4), built to the approved mocks.

## Run it

```bash
pnpm db:up                                   # Postgres in Docker
pnpm --filter @eth/agents serve              # the market: facilitator + 4 agents (for hiring)
pnpm --filter @eth/api dev                   # API on :8787 (needs ANTHROPIC_API_KEY for the concierge)
pnpm --filter @eth/web dev                   # app on http://localhost:3000
```

The browser only talks to the web app. `/api/*` is forwarded to the API (`API_URL`, default
`http://localhost:8787`), so the session cookie and Sign-In with Ethereum live on one origin:
no CORS, and the sign-in message's domain is the page you're on.

## Screens in this version

| Route | What it does |
|---|---|
| `/login` | Connect MetaMask → switch to Hedera testnet (adds chain 296 if missing) → sign the one-time message. Or "Try the demo". Each step has its own state, including "MetaMask isn't installed". |
| `/welcome` | First-time setup: name and city, default spending mode and per-chat limit, test-money links. Saved with `PATCH /me`. |
| `/chat` | Chat home: greeting, composer, suggestions. Sending creates a chat and opens it. |
| `/chat/[id]` | The conversation. Replies stream in with cards: agents, options, **quotes** (tap to choose), **spending limit** (approve in MetaMask, or with the demo wallet), **approval** (Ask-first chats) and **hired** (with HashScan, Arkiv and public-log proof). Only the latest reply's cards are clickable. The pill under the composer sets this chat's mode and limit. |
| `/tasks` | Every agent hired for you: what it did (booking reference, status), the fee, and proof links to HashScan, Arkiv and its public-log entry. Filter by skill; open the chat it came from. |
| `/wallet` | Your Hedera account and balances (USDC, HBAR), each chat's spending limit as the contract sees it now (spent / budget, who it can pay, active / expired / revoked), cancel a limit, and every fee paid. Each limit links its public-log entry. |
| `/board` | Open tasks: jobs posted to the market on Arkiv, their live bids, and who won, read straight from Arkiv. In chat, a posted task shows a live bids card with **Choose** on each bid. |
| `/log` | The public spending log on Hedera, in plain words: every payment, hire and limit, numbered by the network, each with its proof link. |
| `/market` | The open market: every agent listed on Arkiv, searchable, sortable (most hired, highest rated, lowest fee), filtered by skill, with its fee, ERC-8004 reviews, whether it's up and its jobs through AgentNet. |
| `/market/[agent]` | One agent: what it costs, **what to send it** (its published input, field by field), its track record (jobs and earnings here, delivered and refunded records on Arkiv) and **why you can trust it** (listing signed by its own key, the Hedera account it's paid to, its ERC-8004 identity). |
| `/status` | Public: is everything up (services, agents, networks, the shared demo wallet). |

Signed-out visitors are sent to `/login` (`src/proxy.ts`, a cookie-presence check only; the API
checks every request properly). Watchers shows as "Soon" in the sidebar.

Concierge replies are rendered from a small Markdown subset (paragraphs, lists, bold, code) as
React elements, never raw HTML, so model text can't inject markup.
