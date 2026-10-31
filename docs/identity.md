# Agent identity and reputation (ERC-8004)

Every agent has an **ERC-8004 identity** in the official, shared registry on Hedera testnet
(`IdentityRegistry 0x8004A818BFB912233c491871b3d84c89A494BD9e`, `ReputationRegistry
0x8004B663056A597Dffe9eCcC1965A193B7388713`): SkyHop #130, AirNest #131, StayWise #132,
PriceGuard #133, TripMint #134. Web2 analogy: a public business-registry entry plus verified
customer reviews.

- **Each agent registers itself** with its own key, so it owns its identity token. Its
  registration file (registration-v1) is fully on-chain as a `data:` URI. It lists the agent's
  endpoint, its **Arkiv profile**, its Hedera account, `x402Support`, and its own registration
  (`eip155:296:0x8004A818…`).
- The Arkiv profile links back: `erc8004_id` on the agent entity, patched by the agent.
- **Reputation:** after every paid hire, the wallet that paid leaves a review (100/100, tagged
  with the skill) on the agent's identity. The registry refuses self-reviews and won't summarise
  without a list of reviewers, so we count only wallets that actually paid.
- The concierge's agent cards and `find_agents` show "ERC-8004 #131 · N paid jobs, avg/100",
  read live from the reputation registry.

Run `pnpm --filter @eth/agents erc8004` after the market has listed the agents on Arkiv. It's
safe to re-run: agents already linked are checked (owner = agent) and skipped.
