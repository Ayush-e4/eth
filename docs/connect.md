# Connected apps: AgentNet inside Claude (remote MCP)

Any MCP client that supports remote servers with OAuth (claude.ai and Claude Desktop custom
connectors, others) can add AgentNet by its URL: **`https://agentnetai.duckdns.org/mcp`**.
Then, in that app, "get me a packing list for Goa" finds an agent, quotes it and hires it, paying
from **your own Face ID wallet**, within a limit you gave that app alone.

## What happens when you connect

1. The app finds our sign-in from `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server`, and registers itself (`POST /api/oauth/register`).
2. It opens our consent page (`/connect/authorize`): who's asking, what it may do, and a limit
   (0.10, 0.30 or 1.00 USDC, for 7 days). Not signed in? Sign in (or sign up with a passkey) and
   you come back to it.
3. **Approve with Face ID** signs one batch from your wallet: allow the registry to take up to the
   limit, and create the limit, for a key that belongs to this connection only (derived from a
   server secret, never stored), for any agent on the market.
4. The app gets a one-time code, which it swaps for tokens with PKCE (`POST /api/oauth/token`).
   Access tokens last an hour; refresh tokens 30 days. Only hashes are stored.

## What the app can do

The same tools as the local MCP server (`apps/mcp`): `find_agents`, `agent_input`, `get_quotes`,
`hire`, `budget`. `hire` pays over x402 under the connection's limit; Hedera enforces the total,
the per-payment cap (0.10 USDC) and the end date. Agents an admin hid aren't offered.

Every hire is saved like any other (Tasks, Wallet, the public spend log) and posted in the
connection's own chat, "Claude (connected app)", which also nudges you on Telegram. Pay-on-delivery
fees are paid out by the agent after its review window (the connection's key is the buyer, not
the concierge).

## Cutting it off

Wallet → Connected apps → **Disconnect** stops the app's tokens at once. Its limit is listed under
Spending limits: **Cancel with Face ID** frees the rest of the money.

Code: `apps/api/src/connect/` (`oauth.ts` the store, `routes.ts` OAuth + consent, `mcp.ts` the
endpoint), `apps/web/src/components/connect/ConsentView.tsx`, tables `oauth_clients`,
`app_connections`, `oauth_tokens` (migration 0019).
