# Arkiv friction report

Honest notes from building on Arkiv: Tiramisu with SDK 0.8.1 until 31 Oct 2026, then Rabdi with
SDK 1.0.0. Dated entries; newest last.

## 2026-10-21

| # | Friction | Impact | What we did |
|---|---|---|---|
| 1 | **Faucet needs a browser wallet sign-in** before showing anything | Took us a while to find that, once signed in, a small "Use a different address" link lets you fund a server wallet directly | Signed in with MetaMask, sent 10 GLM to the platform wallet; the platform funds agent wallets in code |
| 2 | **`data.arkiv.network` doesn't list Tiramisu** (per Arkiv's own `network_status`) | The docs' data-explorer link can't show our entities | Link judges to `tiramisu.explorer.arkiv.network/tx/…` and `/entity/…` instead |
| 3 | **`ne()`, `exists()`, `hasType()` are exported by the SDK but rejected by the network** | Easy to write a query that type-checks and then fails at runtime | Avoided them; use `not(eq(...))` where needed |
| 4 | **Only newest-first ordering** | "Cheapest quote first" can't be a query | Fetch, then sort client-side; keep result sets small with filters (`lte` on `price_units`) |
| 5 | **Durations must be whole blocks (multiples of 2s)** | `fromSeconds(7)` throws | `LIFETIME.quote()` rounds down to an even number |
| 6 | **Parallel writes from one wallet collide on the nonce** | Agents posting several quotes at once would fail | `viem` `nonceManager` on every writer; batches where possible |
| 7 | **camelCase attribute names reportedly revert on Tiramisu** (plugin known issue) even though the SDK accepts them | Silent footgun | All attribute names are lowercase snake_case |
| 8 | **`$creator` must be checked by every reader** — the project tag is copyable | Easy to trust spoofed records | Central `decodeEntity()` enforces authorship per kind; receipts use `.createdBy(platform)` |
| 9 | **A quote's lifetime starts when the write lands**, and reads take time | Our 20 s flash deal showed "~8 s left" by the time it was listed | Fine for the demo; real quotes use 180 s, and the UI shows seconds left from the head block |
| 10 | Node 25 prints a `--localstorage-file` warning when the SDK loads | Noise in logs, no functional effect | Ignored |

## 2026-10-31 (open tasks with bids)

| # | Friction | Impact | What we did |
|---|---|---|---|
| 11 | **The keyless query budget runs out quietly.** With three agents watching the board and a live bids card polling, `arkiv_query` started returning HTTP 429 `ANON_COST_LIMITED` ("unauthenticated query budget exhausted"), while `eth_blockNumber` still worked | viem's default transport retries 429 with back-off, so our reads **hung for minutes instead of failing**; the chat looked frozen. We found the cause only with a raw `curl` | Transport now uses `retryCount: 1` and a 15 s timeout, and sends `X-API-KEY` when `ARKIV_API_KEY` is set. One shared board watcher for all agents (every 15 s), bid reads cached 8 s, slower polling |
| 12 | **The budget and its reset aren't visible.** Nothing tells you how much of the keyless budget is left or when it resets | Hard to size polling before you hit the wall | Budgeted our reads (above); asked for an access key |
| 13 | No subscription for "new entities matching a query" | Bidders and the bids card must poll | Polling, cached and shared. A websocket "watch query" would remove most reads |

### Moving to Rabdi + SDK 1.0 (same day)

| # | Friction | Impact | What we did |
|---|---|---|---|
| 14 | **The testnet changed under us, with no notice we saw.** Tiramisu vanished from the Hub (Networks and Access Keys list only Rabdi), its keyless budget was exhausted, and keys can't be made for it | Our running app stopped reading Arkiv | Moved to Rabdi |
| 15 | **SDK 0.8.1 can't write to Rabdi.** A 0.8.1 `createEntity` fails with `"$contentType" is owned by the engine and cannot be written. Only $payload and $contentType are yours to set`. The message contradicts itself | Hard to tell whether to fix our code or upgrade | Upgraded to 1.0.0 (released 30 Oct, one day earlier) |
| 16 | **SDK 1.0 is a rewrite:** no `attr` module, records are `defineSchema` schemas, writes take `(schema, values, options)`, payloads become `bytes` columns, queries go `select().from(schema)` | Our whole Arkiv layer (~700 lines) had to change | Kept our trust rules: one named schema per kind, a `body` bytes column with the JSON record, the same `decodeEntity` checks |
| 17 | **Rabdi caps lifetimes at 7,884,000 blocks (~182 days).** Our 365-day ratings failed with "more than the chain's maximum lifetime" | A rating written **after an agent was paid** threw, and the paid hire was lost (twice, as the concierge retried) | Ratings now 180 days; post-payment Arkiv records are best-effort and never discard a paid hire |
| 18 | The access key is sent **in the RPC URL path** (`rabdi({ accessKey })`) | Easy to leak in logs or a browser bundle | Server-side only; the docs note it's "not a secret" but should be origin/IP-restricted |

**Suggestion:** return the remaining budget and reset time as response headers on
`arkiv_query`, and document that 429 + viem's default retries looks like a hang.

## What worked well

- `executeBatch` made "publish profile + all listings" a single atomic write.
- Expiry as a first-class field: quotes clean themselves up with zero code.
- Typed attributes with range predicates (`lte("price_units", u64(...))`) map directly onto
  marketplace search.
- Existing `quote` records were already "bids on a task": open tasks needed only two new kinds
  (`task`, `claim`) and no new trust rules beyond "the poster wrote it".
- `patchEntity` on a mutable task + a read-only claim gave us "only the poster can award, and the
  award can't be edited" without any server of ours enforcing it.
- The official Claude plugin's `check_schema` caught a wrong explorer link and a missing
  lifetime-extension story before we shipped.
