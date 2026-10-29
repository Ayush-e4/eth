# Agents — the first working marketplace

Four agents that find each other on Arkiv, compete on price, pay each other over x402, and stay
inside a mandate a human signed on Hedera.

| Agent | Role | Sells | Fee | Backed by |
|---|---|---|---|---|
| **Orchestrator** | Buyer. An agent (Claude Haiku on the Tool Runner): plans, gets quotes, checks hotels, hires, explains | — | — | Claude Haiku (`claude-haiku-5-5`) |
| **SkyHop** | Specialist | `flights`: cheapest fare | 0.05 USDC | Duffel (test mode) |
| **AirNest** | SkyHop's competitor | `flights`: cheapest fare | 0.03 USDC | LiteAPI flights (sandbox) |
| **StayWise** | Specialist | `hotels`: best-value hotel for the traveller's wishes; later changes and cancels | 0.04 USDC (+ 0.02 change, 0.01 guest) | LiteAPI hotels (sandbox) |
| **PriceGuard** | Watcher | rebooks your hotel when the price drops ([docs/priceguard.md](priceguard.md)) | 20% of the saving, paid on proof | via StayWise |

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
   │    6. agent books in its sandbox: round-trip flight (Duffel order / LiteAPI prebook → book),
   │       hotel from the room it locked when quoting
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

## The orchestrator is an agent

Web2 analogy: a travel assistant with a company card. It can look things up freely, but every card
swipe goes through one checkout counter that enforces the rules — and the card has a hard limit.

- **Dates first, in code.** `planTrip` (Claude, structured output) reads the request against a calendar;
  code rejects impossible dates. The trip also carries `hotelWishes` ("quiet, beachfront").
- **Then Claude runs the marketplace** with the SDK's Tool Runner (`orchestrator/agent.ts`):

| Tool | What it does | Who enforces what |
|---|---|---|
| `get_quotes(skill)` | Discover agents on Arkiv, keep mandate payees, collect signed quotes, rank by total cost | code |
| `hire_agent(skill, quoteKey, reason)` | Pay the fee over x402 and have the agent book | code: known quote only, once per skill, one retry after a refund; the **mandate onchain** caps spend |
| `finish(explanation)` | The traveller-facing summary | — |
| LiteAPI MCP (read-only) | Hotel search by meaning, reviews, "ask the hotel" | allowlist: booking tools are off |
| `web_search` | One destination fact (weather, events) | `max_uses: 2` |

Claude may pick a quote that isn't the cheapest, but must say why; the reason and rank go into the
Arkiv job record. StayWise turns wishes into hotels with LiteAPI's search-by-meaning and locks the
cheapest strong match. `--autopilot` runs the old fixed flow without the agent loop.

**Models:** Claude Haiku for everything. The basic web search tool is used because Haiku sent
malformed inputs to the newer dynamic-filtering version in our tests; Sonnet is reserved for
anything Haiku can't do.

## One task format for every agent

Every agent speaks the same request, whatever it does (`packages/shared/src/task.ts`):

```json
{ "task": "trip-goi-mvtxbyn7", "skill": "hotels", "input": { …skill-specific… }, "quoteKey": "0x…" }
```

- `input` is checked against the agent's own schema; its JSON Schema is on the agent's profile
  (`GET /` → `inputSchema`), so a buyer can learn how to call an agent it has never seen.
- Flights and hotels take a Trip as `input`; a research agent would take `{ question, sources }`.
- Errors are codes, not prose: `wrong_skill` (400), `invalid_input` (422, with the failing
  fields), `unknown_or_expired_quote` (409), `work_failed` (502, fee refunded). All of them are
  checked before the paywall, so nobody pays for a request the agent would refuse.

Live check (2026-10-30, autopilot, mandate #27): StayWise booked Fairfield by Marriott Goa
Calangute (0.04 USDC, [tx](https://hashscan.io/testnet/transaction/0.0.11045937@1793301381.086667411)),
AirNest beat SkyHop by ₹406 on total cost (0.03 USDC,
[tx](https://hashscan.io/testnet/transaction/0.0.11045937@1793301379.855836212)), all through the
new envelope.

## Managing a booking later

The traveller comes back: *"add a night"*, *"put Rohan's name on the hotel"*, *"cancel the hotel"*.
`pnpm --filter @eth/agents manage "…"` loads the saved trip, and a follow-up Claude agent works through
StayWise, the agent that made the booking.

| Action | StayWise route | Fee | Under the hood (LiteAPI) |
|---|---|---|---|
| Look up | `POST /bookings/:id/view` | free | booking + refund rules + cost of cancelling now |
| Change dates / guests | `…/change-options` → `…/change` | 0.02 USDC | locked alternatives at the same hotel → rebook; old booking auto-cancelled |
| Change lead guest | `…/guest` | 0.01 USDC | amendment request (`PENDING` until the hotel processes it) |
| Cancel | `…/cancel` | free | `CANCELLED` (refund) or `CANCELLED_WITH_CHARGES` |

- **Only the buyer can touch a booking.** Web2: "only the account that ordered can modify the order".
  Here every request is **signed** with the orchestrator's key (`src/auth.ts`), and StayWise checks
  the signer is the *buyer* on the booking's **Arkiv job**. Checked before any fee is charged.
- **Refundable by default.** StayWise books free-cancellation rates unless the traveller says price
  matters more (`nonRefundableOk`), because non-refundable bookings can't be changed or refunded.
- **Claude asks before money is lost** (`ask_user`): a change that costs more than what was paid, or
  a cancellation with charges. Code refuses those actions until the traveller said yes; cheaper
  changes and free cancellations just happen.
- **The public record follows:** the old Arkiv job becomes `changed` (a new job + receipt for the new
  booking) or `cancelled`; each fee has a receipt.
- Each agent keeps its own records in a local JSON file (`.staywise.local.json`, `.trips.local.json`,
  gitignored) until Postgres arrives.

Live (13–15 Nov trip, Park Inn Candolim, refundable):

| Request | What happened |
|---|---|
| "one more night, check out on the 16th" | options +57% → **asked**: "28,050.63 INR total, up from 17,815.68… extra 10,234.95 INR plus a 0.02 USDC fee. Proceed?" → yes → new booking `h6Byy7oZ6`, old `nQ2dX8UFw` cancelled by LiteAPI. Claude also warned the return flight leaves 15 Nov 00:05, so the extra night is wasted unless flights change |
| "put Rohan as lead guest" | amendment #3661 `PENDING`, 0.01 USDC |
| "plans changed, cancel the hotel" | free cancellation, no question → `CANCELLED`, refund ₹28,051, job marked `cancelled` |

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
- **Firm hotel quotes.** StayWise locks the room with LiteAPI (prebook) *before* quoting, trying the
  next-cheapest room if one can't be locked, so "sold out" happens before anyone pays.
- **Dates are checked in code.** Claude looks weekdays up in a 3-week calendar (India time); the
  plan is rejected if departure isn't after today or return isn't after departure (one retry).
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
pnpm --filter @eth/agents manage "add one more night to the hotel"   # [--yes|--no] to answer for you
pnpm --filter @eth/agents priceguard   # one PriceGuard round [--simulate-drop N, sandbox only]
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

Agent mode, request: *"Plan a weekend in Goa for 2 of us from Mumbai, leaving next Friday and back on
Sunday. Budget ₹40,000. We'd love a quiet beachfront hotel and nonstop flights."*

```
plan: 2 adults BOM→GOI 2026-10-23…2026-10-25 (return flight)
claude → get_quotes flights · get_quotes hotels                (in parallel)
claude → liteapi.get_data_reviews {"hotelId":"Dunhill Beach Resort"}   → 400, wrong id
claude → liteapi.get_data_hotels_semantic_search "quiet beachfront resort in Goa"  → finds the id
claude → liteapi.get_data_reviews lpd3b84 (with sentiment) · web_search "Goa weather late October"
claude → hire_agent flights: rank 1, ₹14,282, both legs nonstop as requested
claude → hire_agent hotels: Dunhill Beach Resort (StayWise matched "quiet, beachfront", 0.77);
         reviews: quiet and peaceful, beachfront; some AC/maintenance complaints
```

| Result | |
|---|---|
| Flights | Air India Express IX1163 out + IX1209 back, AirNest, `FH-26A-A9O4HO54` (pending confirmation) |
| Hotel | Dunhill Beach Resort, Agonda, ₹14,910, booking `kT9UyS4mA` confirmed |
| Total | ≈ ₹29,196 of ₹40,000; fees 0.03 + 0.04 USDC through mandate #14 |
| Proof | [flights fee](https://hashscan.io/testnet/transaction/0.0.11045937@1792610440.116013437), [hotel fee](https://hashscan.io/testnet/transaction/0.0.11045937@1792610440.940325765); Arkiv jobs [flights](https://tiramisu.explorer.arkiv.network/entity/0x574e15d90ed37a7582db7c5f08e86a4dbc11172f6326d17962c92b8cdc82b863), [hotel](https://tiramisu.explorer.arkiv.network/entity/0x53c947f54c9273726d39ff4614787e582d05ad10262cc8073d235aecbaf026c0) |

In an earlier run, before StayWise understood wishes, the agent researched the only hotel offered
(a busy-area, non-refundable room), judged it didn't match "quiet beachfront" and **declined to pay
for it** — booking the flights only and saying why.

What earlier live runs caught (all fixed): placeholder-looking phone numbers; a paid agent that failed
kept the fee (now it refunds — [seen live](https://hashscan.io/testnet/transaction/0.0.11116427@1792609053.346192286));
"next Friday" read as today; rooms selling out between quote and payment (firm quotes); web search
inputs malformed with the newer tool version on Haiku.

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
| `apps/agents/src/orchestrator/agent.ts` | The agent: Tool Runner loop, prompt, LiteAPI MCP + web search |
| `apps/agents/src/orchestrator/tools.ts` | `get_quotes`, `hire_agent`, `finish` and their guardrails |
| `apps/agents/src/orchestrator/quotes.ts` | Discover → mandate filter → quotes → rank |
| `apps/agents/src/orchestrator/hire.ts` | Pay → record (and the autopilot `hire`) |
| `apps/agents/src/orchestrator/explain.ts` | Claude: "why did my agent spend this?" |
| `apps/agents/src/specialists/staywise-manage.ts` | StayWise booking management routes (signed, owner-checked, fees) |
| `apps/agents/src/orchestrator/change-agent.ts` + `change-tools.ts` | The follow-up agent and its guardrails (`ask_user`) |
| `apps/agents/src/auth.ts` | Signed agent requests |
| `packages/travel/src/liteapi-manage.ts` | LiteAPI look up / alternatives / rebook / amend / cancel |
| `apps/agents/scripts/demo.ts`, `manage.ts`, `runtime.ts` | Book a trip; change it later; shared wiring |
