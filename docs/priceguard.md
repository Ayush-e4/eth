# PriceGuard — paid only when it saves you money

An independent agent on the marketplace. It watches your **refundable** hotel booking; if the same stay
gets cheaper before free cancellation closes, it has the hotel's agent rebook it and keeps **20% of the
saving**. You keep 80%, and it is only paid after your own agent checks the proof.

Web2 analogy: "price-drop protection", but the protection service is a third party you can verify,
not a promise from the booking site.

## From the chat

*"Turn on PriceGuard for my Goa hotel: rebook it if it gets at least ₹500 and 5% cheaper."*

- `guard_hotel_price` (concierge): the app signs the permission slip with the concierge's key
  (the booking's buyer on Arkiv) and registers it with PriceGuard; free to turn on. The chat gets
  a **live card** (limits, each check, rebooks and fees, Check now, Stop watching), and the
  **Watchers** page lists it too.
- PriceGuard checks on a schedule (`PRICEGUARD_EVERY_MIN`, default 60) and keeps each check.
- Each rebook is posted in the chat with **Pay PriceGuard** / **Not now**. `pay_invoice` reads the
  invoice from Arkiv and checks its proof (signed by StayWise, a real saving, a fee of 20%, under
  5 USDC). A fee above the chat's limit gets a one-off limit card for exactly that amount, payable
  only to PriceGuard; the server accepts no other card. In "Ask first" chats there's an approval.
- "My bookings" follows a hotel PriceGuard rebooked (StayWise's `replacedBy`) to the booking now.
- Sandbox demos: `PRICEGUARD_SIMULATE_DROP=N` (market) shows a SIMULATED drop, acted on **once**
  per watch; invoices for a simulated saving are refused unless `PRICEGUARD_PAY_SIMULATED=1` (API).

Live (1 Nov 2026): booked Crystall Goa Emerald Edition 8–10 Dec (log #143) → PriceGuard on (₹100,
1%) → Check now: SIMULATED 2% drop, rebooked, saved ₹249, invoice 0.52 USDC → chat: "Pay
PriceGuard" → the concierge warned it was simulated → one-off 0.52 USDC limit approved → paid
(log #146). Found on the way: with the simulated drop on, every 2-minute check rebooked again (4
rebooks); now a simulated drop acts once and later checks say so.

## Who does what

| Agent | Role |
|---|---|
| Your orchestrator | Signs PriceGuard's permission slip; later checks proofs and pays invoices |
| StayWise | Holds the booking (its LiteAPI account), so it rebooks; signs a receipt of what happened |
| **PriceGuard** (Hedera `0.0.11118483`, own Arkiv listing) | Watches, decides when to act, invoices its cut |

## The flow

```
you: "keep an eye on our hotel price"
  orchestrator ──signs──▶ permission slip: "PriceGuard may reprice booking X at StayWise —
                          same stay, refundable only, saving ≥ ₹500 and ≥ 5%, until check-in"
  PriceGuard ──registers slip──▶ StayWise   (StayWise checks YOU signed it: the booking's owner)

every few hours (demo: `priceguard`, one round):
  PriceGuard ──▶ StayWise: best refundable price now for the same stay? (locked)
  if it beats YOUR limits and free cancellation is open:
    StayWise books the cheaper rate FIRST, then cancels the old one (rolls back if that fails)
    StayWise ──signs──▶ receipt: old/new booking, old/new price, saving
  PriceGuard ──▶ Arkiv: invoice = 20% of the saving (USDC at today's rate) + StayWise's receipt

next time you use the app ("did PriceGuard save us anything?"):
  orchestrator checks the invoice: receipt signed by StayWise? about this trip? real saving?
  fee = 20% (±2%)? under the 5 USDC cap?  → pays via x402 through your mandate, else refuses
```

Your money: the old booking's refund goes back to your card and the new one costs less, so the
saving stays with you; only the 20% fee moves to PriceGuard, in USDC.

## Rules enforced in code

- **Only you set the limits.** StayWise enforces the limits in your signed slip; PriceGuard can't act
  below them. Change them any time: `manage "only rebook if it saves ₹1000"` re-signs the slip.
- **Never two rooms, never a lost room.** New booking first, then cancel; if the cancel fails the new
  booking is cancelled. Only before the free-cancellation deadline; non-refundable bookings are skipped.
- **Pay on proof.** A forged, edited, other-trip, no-saving, wrong-fee or over-cap invoice is refused.
- **Simulated savings cost nothing.** For sandbox demos, `priceguard --simulate-drop 6` makes StayWise
  pretend the booking cost 6% more. The signed receipt, the invoice and every message say
  **SIMULATED**, and your agent refuses to pay for it unless you run `manage … --demo-pay-simulated`.
  The trip still follows the (real) rebook.

## Live run (sandbox, 2026-10-22)

| Step | Result |
|---|---|
| Book | Park Inn Candolim, 20–22 Nov, ₹12,974, free cancellation (`0TjDMXqhh`) |
| `manage "keep an eye on our hotel price"` | slip signed: ≥ ₹500 and ≥ 5%, until 20 Nov; StayWise accepted it |
| `priceguard --simulate-drop 6` | saving ₹778 (5.7%) **[SIMULATED]** → rebooked `QqJ3cvkRS`, invoice 1.65 USDC on Arkiv |
| `manage "did PriceGuard save us anything?"` (before the simulation rule) | proof verified → paid 1.65 USDC ([tx](https://hashscan.io/testnet/transaction/0.0.11045937@1792616117.137859488)). Claude pointed out the total hadn't really changed — which led to the rule above |
| `priceguard --simulate-drop 6` again | sandbox price had risen to ₹13,796 → "not worth it", nothing done |
| `priceguard --simulate-drop 12` | ₹1,557 [SIMULATED] → rebooked `1O1tIJFCL`, invoice 3.30 USDC |
| `manage "did PriceGuard save us anything new?"` | **not paid**: "SIMULATED sandbox drop… no fee is owed"; trip now points at `1O1tIJFCL` |

Found live and fixed: reusing a LiteAPI client reference on a second rebook failed (now unique).

## Code

| File | What |
|---|---|
| `apps/agents/src/specialists/priceguard.ts` | The agent: `/watch`, `checkOnce`, invoices, `/invoices/:key/pay` |
| `apps/agents/src/specialists/staywise-reprice.ts` | StayWise: `/delegate`, `/reprice-options`, `/reprice` + signed receipt |
| `apps/agents/src/orchestrator/priceguard-tools.ts` | `watch_price`, `review_invoices`, `pay_invoice` |
| `apps/agents/src/orchestrator/invoices.ts` | Pay-on-proof checks |
| `apps/agents/src/auth.ts` | Signed statements (permission slips, receipts) |
| `packages/arkiv` `invoice` record | Public bill with its proof (see `arkiv/schema.md`) |
| `apps/agents/scripts/priceguard.ts` | One watch round (`--simulate-drop N`, sandbox only) |
