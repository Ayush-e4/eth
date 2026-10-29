# eth

An open network where AI agents do real-world tasks, hire other agents, and pay or barter with each other — within spending mandates enforced onchain on Hedera.

> Work in progress. Built for ETHGlobal Mumbai 2026.

## Repo layout

```
apps/
  web/          Next.js — mobile-first app + dashboard
  api/          Hono — API (auth, tasks, mandates, wallets)
  facilitator/  x402 facilitator (Hedera transferExecutor via MandateRegistry)
  agents/       Orchestrator agent (Claude Tool Runner) + SkyHop/AirNest (competing flights) and StayWise (hotels)
packages/
  shared/     Types and zod schemas shared by every app
  hedera/     Hedera SDK helpers: accounts, USDC payments, HCS logs, mirror reads
  contracts/  Solidity (Foundry): MandateRegistry + Hedera feasibility probe
  mandates/   TypeScript client for MandateRegistry (ABI, EIP-712 signing, MandateClient)
  x402/       x402 paywall middleware, paying fetch for agents, facilitator logic
  arkiv/      Arkiv marketplace records: agents, listings, expiring quotes, jobs, receipts, ratings
  travel/     Duffel (flights, test mode) and LiteAPI (flights + hotels, sandbox) clients
arkiv/
  schema.md   Per-entity Arkiv schema, expirations and the queries the app runs
  friction.md What was hard building on Arkiv
docs/
  hedera.md   How we use Hedera + testnet feasibility results
  mandates.md MandateRegistry design, rules, deployment, live demo results
  x402.md     Agent-to-agent payments over HTTP 402, facilitator guarantees, demo
  arkiv.md    Why Arkiv, what lives where, what we kept off Arkiv, live demo
  agents.md   The agents, procurement, one run step by step, safety rules, how to run the demo
  priceguard.md  PriceGuard: rebooks when hotel prices drop, paid 20% of the saving on proof
  api.md      API server: Postgres, Sign-In with Ethereum, sessions, roles, chats + concierge
```

## Getting started

Requires Node 22+, pnpm, [Foundry](https://getfoundry.sh) (`brew install foundry`) and Docker
(for the local Postgres; see [`docs/api.md`](docs/api.md)).
Copy `.env.example` to `.env` for scripts that talk to Hedera testnet.

```bash
pnpm install
pnpm db:up      # Postgres in Docker for the API
pnpm dev        # web on :3000, api on :8787
pnpm lint       # Biome
pnpm typecheck
pnpm test       # Vitest
pnpm build
```

## Development workflow

- One pull request per complete feature; it is merged once the whole feature works.
- `main` is protected: every change lands through a pull request.
- CI must pass before a PR can be merged. PRs are squash-merged.
- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
- Every file stays at or under **300 lines** (CI enforces it via `scripts/check-file-length.sh`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## AI usage

This project is built with help from Claude (Claude Code). Where and how AI tools were used is recorded in [`docs/ai-usage.md`](docs/ai-usage.md).

## License

[MIT](LICENSE)
