# AI usage log

ETHGlobal requires documenting where AI tools were used. Each PR that includes AI-assisted work adds an entry here.

| PR | Area | Tool | What AI did | What the team did |
|----|------|------|-------------|-------------------|
| bootstrap | Repo setup, CI, templates | Claude Code | Drafted config files and workflow | Chose workflow rules, reviewed and approved |
| monorepo skeleton | Workspace, web, api, shared, CI | Claude Code | Scaffolded configs, health route, tests; debugged TS 7 / Next typegen issue | Chose stack (pnpm, Turborepo, Next, Hono, Biome), reviewed |
| hedera foundation | Hedera package, probe contract, scripts | Claude Code | Wrote SDK helpers, tests, probe contract + live checks; debugged Foundry install | Created testnet account, funded USDC, reviewed results |
| mandate registry | Contract, tests, TS client, live demo | Claude Code | Wrote contract, 54 tests (fuzz/invariant), client and demo | Chose custody model (A), x402 executor up front, reviewed rules and results |
| x402 payments | Facilitator, paywall, paying client, settlement proof, Slither CI | Claude Code | Read the x402 spec + SDK, wrote facilitator/middleware/client and tests, ran live demo | Chose to build on official @x402/core, asked for Slither in CI, reviewed design |
