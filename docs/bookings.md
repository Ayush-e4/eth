# Managing bookings

## Hotels: StayWise

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

### From the chat

The same works from any chat: `my_bookings` lists hotels too, and `manage_booking` changes dates
or guests (`change-options`, then a paid `hotels.change` job through `/work`, the same as a
flight change) or cancels after an approval card showing what comes back. A change makes a new
booking at LiteAPI, so its id becomes the booking's reference from then on (sandbox confirmation
codes are all "test").

Live (31 Oct 2026): booked Crystall Goa Emerald Edition 4–6 Dec (log #137) → "add a night,
check out on 7 December": two options, +46% and +153% → approval card "It costs 46% more…" →
new booking SvlUnIkh9 replacing h-rW53ZSj (log #140) → "cancel my Goa hotel": card "18268.68
INR comes back" → approved → both bookings show CANCELLED at LiteAPI.

## Flights: SkyHop, from the chat

*"Move my flight to the next day"*, *"cancel my flight"* work in any chat: the concierge's
`my_bookings` lists the user's flights (from every chat, as they stand after changes) and
`manage_booking` talks to SkyHop, which made the booking (`src/specialists/skyhop-manage.ts`,
Duffel orders in `packages/travel/src/duffel-orders.ts`).

| Action | SkyHop route | Fee | Under the hood (Duffel test mode) |
|---|---|---|---|
| Look up | `POST /bookings/:id/view` | free | the order, and whether the airline allows change / cancel |
| Move a flight | `…/change-options` → paid `/work` job `flights.change` | 0.02 USDC | change request → offers (fare difference + airline penalty) → confirm, paid from the balance |
| Cancel | `…/cancel-quote` → `…/cancel` | free | cancellation quote (refund) → confirm |

- **A change is an ordinary job.** Each option is an Arkiv quote with skill `flights.change`; the
  concierge pays it with `hire_agent`, so it gets the chat's limit, approvals, the undo window,
  pay on delivery with review and dispute, and crash recovery. Agents can offer such follow-up
  jobs with `followUps` in their definition (`server.ts`).
- **Asked in code, not by the model.** An option that costs more at the airline carries
  `confirm`: the app shows an approval card even in "Auto" chats, and only an approval for that
  very option counts. Cancelling always shows the refund on an approval card first.
- **Only the buyer:** SkyHop checks the request's signer (the concierge) is the buyer on the
  booking's Arkiv job; the app checks the booking's hire is in one of this user's chats.
- In test mode SkyHop takes Duffel Airways when offered (`SKYHOP_AIRLINE`, default `ZZ`): its
  bookings really can be changed and cancelled, while real airlines' sandbox fares often fail.
  Seats and bags aren't offered on these test orders, so they aren't wired yet.

Live (31 Oct 2026): booked 4HBJBO, ZZ7426 on 10 Dec (log #126) → "move my flight 4HBJBO to 11
December": three flights offered, each £125 more (£25 penalty) → approval card → moved to ZZ1460,
11 Dec 12:00 (log #129, fee paid on delivery) → "cancel my flight" → card "169.75 GBP comes back"
→ approved → cancelled on Duffel.
