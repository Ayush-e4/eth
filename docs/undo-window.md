# Undo window (Hedera scheduled payments)

In an **Auto** chat the concierge hires and pays agents on its own. The undo window gives the user
a short time to change their mind: the payment is put on Hedera to run in 60 seconds, the chat shows
a countdown and a **Cancel payment** button, and if the user cancels, nothing is paid and the agent
does no work.

Web2 analogy: Gmail's "Undo send", or a bank transfer dated for later that you can still cancel.
The difference is that **Hedera keeps the timer**, not our server: the payment runs when the
window ends even if our servers are down, and once cancelled it can never run.

## How it works

1. The concierge signs an x402 payment as usual and adds `extensions.undoWindow = { seconds }`
   (`packages/x402/src/client.ts`). Its expiry (`validBefore`) is pushed out by the same time.
2. The agent's paywall forwards it to the facilitator's `settle`. Seeing the extension, the
   facilitator wraps the same `MandateRegistry.executeTransfer` call in a **ScheduleCreate**
   (`packages/x402/src/facilitator/scheduled.ts`):
   - `waitForExpiry = true` and `expirationTime = now + seconds`, so it runs exactly when the window ends;
   - `adminKey` = the facilitator's key, so it can be deleted before then;
   - the payer is the facilitator's operator account (it pays the network fees, as before).
3. The API finds the schedule by the payment's key (`GET /schedules/:key` on the facilitator) and
   shows a payment card in the chat (`apps/api/src/hiring/undo.ts`, `PaymentCard.tsx`).
4. **Cancel**: the API signs `agentnet:cancel-payment:<scheduleId>` with the concierge's key; the
   facilitator checks on-chain that the signer is the mandate's agent and sends a
   **ScheduleDelete**. `settle` then fails with `payment_cancelled_in_undo_window` and the agent
   does nothing.
5. **No cancel**: Hedera runs the call when the window ends. The facilitator reads the mirror
   node's records for the scheduled transaction and runs the same settlement checks as an instant
   payment (payer debited, payee credited, only the asset moved), then the agent does the job.

Every step is in the public spend log: `x402.scheduled`, `x402.schedule.cancelled`, `x402.settled`.

## Who can cancel

Only the chat that made the payment (the API keeps scheduleId → chat), and only through the
mandate's agent's signature, which the facilitator checks against `MandateRegistry.getMandate`.
The facilitator holds the schedule's admin key, so a cancel can't come from anyone else.

## Config

- `UNDO_SECONDS` (API, default 60; 0 turns undo windows off). Clamped to 10–600 by the facilitator.
- "Ask first" chats don't use it: the user already approved each payment.

## Gotchas found

- A scheduled transaction's id ends in `?scheduled` and shares the mirror id with its
  ScheduleCreate. The mirror's `?scheduled=true` filter **drops the child records**, and with them
  the token transfer, so the check saw "payee credited 0" for a payment that went through. We
  fetch the whole family and keep the scheduled call plus its children
  (`packages/x402/src/mirror-records.ts`).
- A restart doesn't lose a payment in its window. It still runs when the window ends; the agent
  sees it on-chain and does the job ([agent-jobs.md](agent-jobs.md)), and the API reads the result
  back and posts it ([api.md](api.md#restarts)). On start, the facilitator **adopts** its pending
  undo-window schedules (read back from Hedera with ScheduleInfoQuery), so Cancel keeps working.
- The chat's live events were gzipped, and so held back, by the Next.js `/api` proxy; the stream now
  sends `Cache-Control: no-transform`.

## Live test (testnet, 31 Oct 2026)

- Cancelled: schedule `0.0.11252759`, deleted 17 s before it would run, nothing paid, log #70–#71.
- Paid: schedule `0.0.11252794`, ran at the end of the window, AirNest did the job, log #72–#74.
