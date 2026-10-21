# Agents — the first working marketplace

Four agents that find each other on Arkiv, compete on price, pay each other over x402, and stay
inside a mandate a human signed on Hedera.

| Agent | Role | Sells | Fee | Backed by |
|---|---|---|---|---|
| **Orchestrator** | Buyer. Turns "plan a Goa weekend" into a trip, runs procurement, explains every spend | — | — | Claude Haiku (`claude-haiku-5-5`) |
| **SkyHop** | Specialist | `flights`: cheapest fare | 0.05 USDC | Duffel (test mode) |
| **AirNest** | SkyHop's competitor | `flights`: cheapest fare | 0.03 USDC | LiteAPI flights (sandbox) |
| **StayWise** | Specialist | `hotels`: best-value hotel | 0.04 USDC | LiteAPI hotels (sandbox) |

Web2 analogy: the orchestrator is a company buyer on Upwork with a company card that has a limit.
SkyHop, AirNest and StayWise are freelancers with public profiles. Upwork's database is
**Arkiv**, the card limit is the **mandate** (MandateRegistry on Hedera), and paying an invoice
is **x402**.

## One run, step by step

```
human ──signs mandate──▶ MandateRegistry (Hedera)       "orchestrator may spend 0.30 USDC,
                                                          max 0.10 per payment, only to
                                                          SkyHop, AirNest, StayWise, for 1 hour"
"Plan a weekend in Goa…"
   │
   ▼
Orchestrator ── Claude: request → Trip {BOM→GOI, dates, 2 adults, budget}
   │
   ├─ for flights and hotels in parallel:
   │    1. find listings on Arkiv (skill = flights)            ← public phonebook
   │    2. drop agents the mandate doesn't allow (isPayeeAllowed, read onchain)
   │    3. POST /quote to each → each posts a signed 3-minute quote on Arkiv,
   │       with its fee AND the item price (ticket / room, in the supplier's currency)
   │    4. procurement: read live quotes from Arkiv, convert to INR at ECB rates,
   │       pick the lowest TOTAL cost (item + fee) — not the cheapest agent
   │    5. POST /work → 402 → sign PaymentAuth → facilitator settles via MandateRegistry
   │    6. agent books in its sandbox (Duffel order, or LiteAPI prebook → book)
   │    7. record job (buyer), receipt (platform), rating (buyer) on Arkiv
   │
   ▼
Claude explains: itinerary, each fee, who won each contest and by how much, caveats
```

### Procurement

AirNest charges a lower fee than SkyHop, so "cheapest agent" would always pick AirNest. The
orchestrator instead compares what the traveller really pays: `item price + agent fee`, both in
INR (`apps/agents/src/orchestrator/procure.ts`). Duffel prices in GBP and LiteAPI in INR, so
prices are converted with the day's ECB reference rates from frankfurter.dev (free, no key); fees
are USDC, valued at the USD rate. Example log line:

```
[flights] chose it: lowest total of 2 comparable quote(s): ₹6,005 total = item ₹6,000 + agent fee ₹5
```

Losing quotes go into the explanation ("AirNest: ₹7,599 total …"). Prices come from the
**signed Arkiv quote**, not from the agent's HTTP reply, so anyone can audit the decision later.
If no quote has a comparable price, it falls back to the lowest fee.

Two kinds of money move, and only one is crypto:

- **Agent fees** (e.g. 0.05 + 0.04 USDC) go from the human's account to each agent's own Hedera
  account through the mandate. Real testnet transfers, visible on HashScan.
- **Booking costs** (flight and hotel prices) are paid inside the providers' sandboxes: Duffel's
  test balance (unlimited in test mode) and LiteAPI's simulated sandbox card. No real tickets or
  rooms are issued.

## Safety rules in code

- **Only test keys.** `DuffelClient` refuses tokens that don't start with `duffel_test_`; both
  LiteAPI clients refuse keys that don't start with `sand_`.
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

- **Pay-first, not pay-on-delivery.** If an agent takes the fee and its booking then fails, it
  refunds the fee itself — a promise, not a guarantee. Planned fix: escrow in MandateRegistry,
  released when the booking is confirmed (LiteAPI webhooks `booking.book`, `flight.book.confirmed`).
- Quotes live in the specialist's memory, so restarting it forgets them (Arkiv still has them).
- Agents run on `localhost`; deploying them gives them public endpoints in their listings.
- Sandbox data: Duffel test mode books "Duffel Airways" (ZZ) at made-up prices; LiteAPI's flight
  sandbox is limited (its test airline is Nuitee Air). A supplier with no results simply doesn't
  quote, and the other agent wins.
- Ratings are always 5 for now; later they'll come from delivery checks.

## Run it

```bash
pnpm --filter @eth/agents identities   # once: Hedera accounts for each agent + orchestrator key + Arkiv gas
pnpm --filter @eth/agents demo         # or: demo "Plan 3 nights in Jaipur for 1 from Delhi, 12 Dec"
```

Needs `ANTHROPIC_API_KEY`, `DUFFEL_ACCESS_TOKEN` (`duffel_test_…`) and `LITEAPI_KEY` (`sand_…`,
one key for flights and hotels) in `.env`, plus the Hedera operator from earlier features (it owns
the mandate and must hold a little testnet USDC). The demo starts the facilitator (:8402), SkyHop
(:8411), StayWise (:8412) and AirNest (:8413), creates a fresh mandate, runs the trip, prints
HashScan and Arkiv links and Claude's explanation, then shuts everything down.

### Testnet identities

| Agent | Hedera account | EVM address |
|---|---|---|
| SkyHop | [0.0.11116426](https://hashscan.io/testnet/account/0.0.11116426) | `0xa21eee5c2efb86f3737cb92d08276a45d03daf5e` |
| AirNest | [0.0.11116757](https://hashscan.io/testnet/account/0.0.11116757) | `0x65f8e30a61635afeb3f33b5221f05b8a6fce3e13` |
| StayWise | [0.0.11116427](https://hashscan.io/testnet/account/0.0.11116427) | `0x78ef54682bce53b3eb9bf9432952423aaa274ad1` |
| Orchestrator | — (signs only; the human's account pays) | `0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8` |

## Live run (testnet + sandboxes, 2026-10-22)

`pnpm --filter @eth/agents demo` with the default Goa request:

| Step | Result |
|---|---|
| Plan (Claude Haiku) | BOM→GOI, 30 Oct → 1 Nov 2026, 2 adults, budget ₹40,000 |
| Flights procurement | AirNest ₹6,260 total (Air India Express IX1051, ₹6,257 + ₹3 fee) beat SkyHop ₹11,346 (Duffel, priced in GBP) |
| Flight booking | LiteAPI sandbox ref `FH-26A-96UUNTIY`, `PENDING_CONFIRMATION` |
| Hotel | StayWise: Park Inn by Radisson Goa Candolim, ₹9,488, booking `7BX71v9sh` `CONFIRMED` |
| Agent fees | 0.03 + 0.04 USDC through mandate #7 — [flights](https://hashscan.io/testnet/transaction/0.0.11045937@1792608415.504001618), [hotels](https://hashscan.io/testnet/transaction/0.0.11045937@1792608417.443920225) |
| Arkiv | jobs [flights](https://tiramisu.explorer.arkiv.network/entity/0x60198716ffe06084749f192238cd565d77d4db3b901ab235cb2bc78f71997d36), [hotels](https://tiramisu.explorer.arkiv.network/entity/0xf4d371b2a4f24f99a5b20a76f2b46f77e954034c01281f9603957c24a2f90e0e), plus receipts and ratings |

Found by the first live run and fixed: LiteAPI rejects placeholder-looking phone numbers; an
agent that is paid and then fails now **refunds its fee** from its own account (until
pay-on-delivery escrow exists); the orchestrator survives non-JSON error replies. Old listings
from the Arkiv demo were correctly skipped (not payees in the mandate).

Gaps seen: only the outbound flight is booked (no return leg yet), and LiteAPI flight bookings
confirm asynchronously (`PENDING_CONFIRMATION`).

## Code map

| File | What |
|---|---|
| `packages/travel/src/duffel.ts` | Duffel flight search + instant order paid from test balance |
| `packages/travel/src/liteapi-flights.ts` | LiteAPI flight search, prebook, book (sandbox) |
| `packages/travel/src/liteapi.ts` | LiteAPI hotel rates, prebook, book (sandbox) |
| `apps/agents/src/specialists/server.ts` | Generic specialist: `/quote` (free) + `/work` (x402) + Arkiv listing |
| `apps/agents/src/specialists/{skyhop,airnest,staywise}.ts` | Each agent: how it quotes and works |
| `apps/agents/src/orchestrator/plan.ts` | Claude: request → structured `Trip` |
| `apps/agents/src/orchestrator/procure.ts` | FX rates + rank quotes by total cost |
| `apps/agents/src/orchestrator/hire.ts` | Discover → mandate filter → quotes → procure → pay → record |
| `apps/agents/src/orchestrator/explain.ts` | Claude: "why did my agent spend this?" |
| `apps/agents/scripts/demo.ts` | The whole run end to end |
