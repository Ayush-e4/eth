# Web app

`apps/web` is the AgentNet console (Next.js 16, Tailwind 4), built to the approved mocks.

## Run it

```bash
pnpm db:up                                   # Postgres in Docker
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
| `/chat/[id]` | The conversation. Replies stream in; agents and options cards render as cards; tapping an option sends it. The pill under the composer sets this chat's mode and limit. |

Signed-out visitors are sent to `/login` (`src/proxy.ts`, a cookie-presence check only; the API
checks every request properly). Market, Tasks, Watchers and Wallet show as "Soon" in the sidebar.

Concierge replies are rendered from a small Markdown subset (paragraphs, lists, bold, code) as
React elements, never raw HTML, so model text can't inject markup.
