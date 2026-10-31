# Paid jobs that survive crashes

An agent is paid before it works (x402). Every step from "paid" to "delivered" therefore has to
survive a crash, a restart or a dropped connection. Otherwise the buyer pays for nothing, or
pays twice. This is how payment systems such as Stripe handle it: a database as the record of
truth, and requests that are safe to repeat.

## The job, step by step

Each specialist keeps its own database (SQLite, `apps/agents/.<agent>.local.db`, gitignored) with
the quotes it gave and every paid job (`src/specialists/jobs.ts`):

```
paying ─(paid)→ working ─→ delivered
   │                  └──→ failed (fee refunded)
   └─(never paid)→ released: the quote can be paid again
```

`POST /work` (`src/specialists/work.ts`):

1. Checks the quote **before** any payment (live, ours, input matches). A quote given before a
   restart is still in the database, so it's still honoured.
2. **Claims the quote** for one job (a single insert: one job per quote, ever) and **records the
   payment** (mandate, nonce, expiry, payer) before it settles.
3. Settles through the paywall. Refused or cancelled → the claim is released. Paid → `working`,
   with the payment's Hedera transaction.
4. Does exactly the quoted job, then `delivered` (with the result) or `failed` (with the refund).
5. Writes a public, read-only **`delivery`** record on Arkiv: delivered (with the sha256 of the
   result, which stays private) or refunded (with the refund transaction).

## The buyer can always get its job back

`/work` is a **signed request** from the buyer (`src/auth.ts`, the same signatures as booking
management). The agent records who signed it, and:

- **Sending the same `/work` again is safe.** The buyer gets its job back as it stands. It never
  pays a second time, and the job is never done twice. Anyone else gets `409 quote_already_used`.
- **`GET /jobs/:quoteKey`**, signed by the same key, returns the job: status, result, the payment
  transaction, and the refund if any. Anyone else gets 404.

The buyer's `buy()` (`src/orchestrator/hire.ts`) does both. If the agent answers 202 (still paying
or working), or the call breaks after paying, it reads the job back instead of paying again. If
the job takes longer than `jobWaitMs`, it throws `HirePending` with where to read the job later.

## The API follows every hire to the end

The concierge writes each hire to `pending_hires` before paying (`apps/api/src/hiring/pending.ts`).
If the turn sees the job through, the row is removed. If not (the API restarted, the connection
dropped, or the agent is still working when `buy()` stops waiting), the API keeps reading the job
back:

- **delivered**: recorded exactly as a normal hire (Arkiv job, receipt and rating, `hires`, spend
  log, ERC-8004 review), then posted to the chat as "X finished the job from earlier", with its card;
- **failed**: posted with the refund;
- **no job at the agent**: the payment never reached it, so nothing was paid; dropped silently.

It checks every 10 s for 5 minutes, then every minute for an hour, then every 10 minutes for a day.
When an agent no longer holds a quote (expired, or another team's agent restarted), the concierge
gets fresh quotes and hires the same agent again if its fee is the same or less.

## After a crash: the chain is the judge

On start, each agent runs `recover()` on the jobs the last run left unfinished:

- **`paying`**: did the payment happen? MandateRegistry marks each `(mandate, nonce)` used when
  it pays, so the agent asks the chain (`paymentState` in `@eth/mandates`):
  - *paid*: do the job (the transaction comes from the registry's `Paid` event on the mirror);
  - *unpaid* (the authorization expired unused): release the quote;
  - *pending* (e.g. in its undo window): ask again every 10 s.

  The same check runs, without a restart, when the facilitator call breaks off mid-payment.
- **`working`**: it stopped in the middle of the job. Doing the job again could book twice with
  the airline or hotel, so the fee is refunded and the job is marked `failed`.

## Pay on delivery (escrow)

Agents ask for their `/work` fee **on delivery** (x402 `extra.escrow`, terms 15 min to deliver,
15 min to review; `ESCROW=off` turns it off for an agent). The buyer signs an `EscrowAuth`
instead of a `PaymentAuth`, and the facilitator calls `executeEscrowTransfer`: the same mandate
checks, but the USDC lands in MandateRegistry, not with the agent. Then:

1. **Delivered.** After the job, the agent calls `markDelivered(escrowId, sha256(result))` from
   its own Hedera account, before it answers, and its job view carries `escrow { id, deliveredTx }`.
2. **Paid out.** The buyer releases it once it has the result: the API with the concierge's key,
   TripMint for the agents it hires. The chat card shows held → delivered → paid out, each
   linked on HashScan.
3. **Failed job.** The agent calls `refund(escrowId)`: the USDC goes back to the payer and the
   spent amount back to the limit.

Every 2 minutes each agent sweeps its open escrows (`escrow.ts`): it retries a delivery or
refund that failed, closes the ones the buyer released, and **claims** a fee the buyer didn't
release within the review window. A buyer that doesn't release (the MCP server has no HBAR)
therefore still pays, 15 minutes later. Every move needs a little HBAR for gas (about 0.06 HBAR
each): `pnpm setup:testnet --fix` tops up the concierge and the agents.

## Limits

- One agent process per database: SQLite's single writer is what makes the claim atomic.
  Several copies of one agent would need a shared database (Postgres) instead.
- A job interrupted mid-booking is refunded, not resumed. A supplier lookup by our reference
  ("did this booking go through?") would let the agent deliver instead.
- A buyer that doesn't sign `/work` (plain x402) still gets paid work, but can't read the job
  back after a dropped connection.
