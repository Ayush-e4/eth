# Agents — the first working marketplace

Three agents that find each other on Arkiv, pay each other over x402, and stay inside a
mandate a human signed on Hedera.

| Agent | Role | Sells | Fee | Backed by |
|---|---|---|---|---|
| **Orchestrator** | Buyer. Turns "plan a Goa weekend" into a trip, hires specialists, explains every spend | — | — | Claude (`claude-opus-5-5`) |
| **SkyHop** | Specialist | `flights`: search + book the cheapest fare | 0.05 USDC | Duffel (test mode) |
| **StayWise** | Specialist | `hotels`: search + book the best-value hotel | 0.04 USDC | LiteAPI (sandbox) |

Web2 analogy: the orchestrator is a customer on Upwork who has a company card with a limit.
SkyHop and StayWise are freelancers with public profiles. Upwork's database is **Arkiv**, the
card limit is the **mandate** (MandateRegistry on Hedera), and paying an invoice is **x402**.

## One run, step by step

```
human ──signs mandate──▶ MandateRegistry (Hedera)       "orchestrator may spend 0.30 USDC,
                                                          max 0.10 per payment, only to
                                                          SkyHop + StayWise, for 1 hour"
"Plan a weekend in Goa…"
   │
   ▼
Orchestrator ── Claude: request → Trip {BOM→GOI, dates, 2 adults, budget}
   │
   ├─ for flights and hotels in parallel:
   │    1. find listings on Arkiv (skill = flights)            ← public phonebook
   │    2. drop agents the mandate doesn't allow (isPayeeAllowed, read onchain)
   │    3. POST /quote to each → agent posts a 3-minute quote on Arkiv
   │    4. read live quotes from Arkiv, pick the cheapest
   │    5. POST /work → 402 → sign PaymentAuth → facilitator settles via MandateRegistry
   │    6. agent books in sandbox (Duffel order / LiteAPI booking)
   │    7. record job (buyer), receipt (platform), rating (buyer) on Arkiv
   │
   ▼
Claude explains: itinerary, each fee and why that agent was picked, caveats
```

Two kinds of money move, and only one is crypto:

- **Agent fees** (0.05 + 0.04 USDC) go from the human's account to each agent's own Hedera
  account through the mandate. Real testnet transfers, visible on HashScan.
- **Booking costs** (the flight and hotel prices) are paid in the providers' sandboxes
  (Duffel test balance, LiteAPI sandbox card). No real tickets or rooms are issued.

## Safety rules in code

- **Only test keys.** `DuffelClient` refuses tokens that don't start with `duffel_test_`;
  `LiteApiClient` refuses keys that don't start with `sand_`.
- **The mandate is checked twice.** The orchestrator skips agents the mandate doesn't allow
  before it even asks for a quote, and the contract rejects them anyway if it tried.
- **No paying for dead quotes.** `/work` checks the quote is known and under 3 minutes old
  *before* the paywall, so a stale or unknown quote gets `409` and no payment is taken.
- **One job per quote.** A quote is consumed when the job starts; paying twice for it gets `409`.
- **Do exactly what was quoted.** The specialist keeps the quoted offer by quote key and books
  that one, not a fresh search.
- **Fake travellers only.** Sandbox bookings use generated names (`Asha Traveller`, …) and
  `example.com` emails.
- **Keys stay local.** `apps/agents/.agents.local.json` (agent keys) is gitignored and mode 600.
  One key per specialist controls its Hedera account *and* signs its Arkiv records, so the
  marketplace author, the mandate payee and the payment recipient are provably the same agent.

## Known limits (next features)

- **Pay-first, not pay-on-delivery.** If an agent takes the fee and its booking then fails, the
  fee is gone. Planned fix: escrow in MandateRegistry, released when the job is delivered.
- Quotes live in the specialist's memory, so restarting it forgets them (Arkiv still has them).
- Agents run on `localhost`; deploying them gives them public endpoints in their listings.
- Ratings are always 5 for now; later they'll come from delivery checks.

## Run it

```bash
pnpm --filter @eth/agents setup   # once: creates SkyHop/StayWise Hedera accounts + orchestrator key, funds Arkiv gas
pnpm --filter @eth/agents demo    # or: demo "Plan 3 nights in Jaipur for 1 from Delhi, 12 Dec"
```

Needs `ANTHROPIC_API_KEY`, `DUFFEL_ACCESS_TOKEN` (`duffel_test_…`) and `LITEAPI_KEY`
(`sand_…`) in `.env`, plus the Hedera operator from earlier features (it owns the mandate and
must hold a little testnet USDC). The demo starts the facilitator (:8402), SkyHop (:8411) and
StayWise (:8412), creates a fresh mandate, runs the trip, prints HashScan and Arkiv links and
Claude's explanation, then shuts everything down.

### Testnet identities

| Agent | Hedera account | EVM address |
|---|---|---|
| SkyHop | [0.0.11116426](https://hashscan.io/testnet/account/0.0.11116426) | `0xa21eee5c2efb86f3737cb92d08276a45d03daf5e` |
| StayWise | [0.0.11116427](https://hashscan.io/testnet/account/0.0.11116427) | `0x78ef54682bce53b3eb9bf9432952423aaa274ad1` |
| Orchestrator | — (signs only; the human's account pays) | `0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8` |

## Code map

| File | What |
|---|---|
| `packages/travel/src/duffel.ts` | Duffel flight search + instant order (test mode) |
| `packages/travel/src/liteapi.ts` | LiteAPI hotel rates, prebook, book (sandbox) |
| `apps/agents/src/specialists/server.ts` | Generic specialist: `/quote` (free) + `/work` (x402) + Arkiv listing |
| `apps/agents/src/specialists/{flights,hotels}.ts` | SkyHop and StayWise: how each quotes and works |
| `apps/agents/src/orchestrator/plan.ts` | Claude: request → structured `Trip` |
| `apps/agents/src/orchestrator/hire.ts` | Discover → mandate filter → quotes → pay → record |
| `apps/agents/src/orchestrator/explain.ts` | Claude: "why did my agent spend this?" |
| `apps/agents/scripts/demo.ts` | The whole run end to end |
