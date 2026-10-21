# AI usage log

ETHGlobal requires documenting where AI tools were used. Each PR that includes AI-assisted work adds an entry here.

| PR | Area | Tool | What AI did | What the team did |
|----|------|------|-------------|-------------------|
| bootstrap | Repo setup, CI, templates | Claude Code | Drafted config files and workflow | Chose workflow rules, reviewed and approved |
| monorepo skeleton | Workspace, web, api, shared, CI | Claude Code | Scaffolded configs, health route, tests; debugged TS 7 / Next typegen issue | Chose stack (pnpm, Turborepo, Next, Hono, Biome), reviewed |
| hedera foundation | Hedera package, probe contract, scripts | Claude Code | Wrote SDK helpers, tests, probe contract + live checks; debugged Foundry install | Created testnet account, funded USDC, reviewed results |
| mandate registry | Contract, tests, TS client, live demo | Claude Code | Wrote contract, 54 tests (fuzz/invariant), client and demo | Chose custody model (A), x402 executor up front, reviewed rules and results |
| x402 payments | Facilitator, paywall, paying client, settlement proof, Slither CI | Claude Code | Read the x402 spec + SDK, wrote facilitator/middleware/client and tests, ran live demo | Chose to build on official @x402/core, asked for Slither in CI, reviewed design |
| arkiv marketplace | Arkiv records, trust rules, schema/friction docs, live demo | Claude Code + Arkiv plugin (check_schema) | Read Arkiv docs, wrote package/tests/demo, ran schema checks | Funded the wallet via faucet, installed Arkiv plugin, chose Arkiv as next feature, reviewed |
| agents | Orchestrator, competing flights agents + hotels agent, procurement, Duffel/LiteAPI clients | Claude Code + Claude in Chrome | Read Duffel/LiteAPI/Claude API docs, checked the Duffel test dashboard, wrote clients, agents, total-cost procurement, tests, demo; found and fixed pay-before-quote-check gap | Got Duffel test access, chose agent roles and to show procurement with two competing flights agents, reviewed design |
| return flights | Round-trip search/booking, trip date checks, firm hotel quotes | Claude Code + LiteAPI docs MCP | Implemented round trips for Duffel + LiteAPI, calendar-based date planning with code validation, prebook-before-quote; ran live demos and fixed what they found | Asked for return flights after #7, set Haiku-only rule, reviewed results |
