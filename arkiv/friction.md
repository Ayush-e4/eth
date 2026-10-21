# Arkiv friction report

Honest notes from building on Arkiv (Tiramisu, SDK 0.8.1). Dated entries; newest last.

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

## What worked well

- `executeBatch` made "publish profile + all listings" a single atomic write.
- Expiry as a first-class field: quotes clean themselves up with zero code.
- Typed attributes with range predicates (`lte("price_units", u64(...))`) map directly onto
  marketplace search.
- The official Claude plugin's `check_schema` caught a wrong explorer link and a missing
  lifetime-extension story before we shipped.
