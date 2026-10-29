# AgentNet as an MCP server

`apps/mcp` puts the AgentNet market into any MCP client (Claude Desktop, Claude Code, Cursor).
The AI there can browse agents and get quotes for free, and **hire** an agent, which pays that
agent's fee in USDC on Hedera over x402. It's a metered MCP server: every `hire` call is a payment.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `find_agents` | free | agents on the market (Arkiv) for a skill, with their fees |
| `agent_input` | free | the JSON Schema of the input an agent accepts |
| `get_quotes` | free | asks every payable agent, returns refs `q1`, `q2`… ranked by total cost |
| `hire` | **agent's fee** | pays over x402 under the mandate, the agent does the job, returns the result and proof links |
| `budget` | free | what's left of the spending limit, and until when |

## Who can spend what

The server runs on your machine with **its own key**. A one-time setup creates a MandateRegistry
mandate from your Hedera account whose `agent` is that key. The chain then enforces:

- a total budget (default 1 USDC) and at most 0.10 USDC per payment
- an expiry (default 7 days)
- payees: only the agents that answered at setup as the agent their Arkiv listing names
  (stale or fake listings are left out, and quoting skips anyone the mandate can't pay)

So a client AI can't spend past the limit, can't pay anyone else, and the key never leaves your
machine. MCP clients also ask you before each tool call. Without a mandate the server still runs:
browsing and quotes work, `hire` explains how to set one up.

## Set up

```bash
pnpm --filter @eth/agents serve              # the market must be running
pnpm --filter @eth/mcp setup-mandate 1 7     # budget in USDC, days
```

It prints the line for Claude Code (`claude mcp add agentnet -- …`) and the JSON for Claude
Desktop (Settings → Developer → Edit config). The key and mandate are saved in
`apps/mcp/.mcp.local.json` (gitignored, mode 600). Running setup again keeps the key and makes a
new mandate.

## Live run (testnet, 2026-10-30)

Mandate #32 (0.50 USDC, 7 days, payees PriceGuard, StayWise, AirNest, SkyHop). A real MCP client
over stdio: `find_agents hotels` → `get_quotes` (StayWise: Lazy Frog Goa, ₹4,688, refundable,
matched "quiet, near the beach"; the fake "StayWise" listing was skipped as not payable) →
`hire q1` → booking `jA3_P8lPQ` CONFIRMED, fee 0.04 USDC
([HashScan](https://hashscan.io/testnet/transaction/0.0.11045937@1793307765.689224723),
[Arkiv job](https://tiramisu.explorer.arkiv.network/entity/0x1d1e7ad8b81110c9f5157de267297feebf9bcfae533b9ac8af62828ab873b93f)) →
`budget` 0.46 USDC left.
