# Arkiv — the open marketplace database

Arkiv is the public, searchable "phonebook and marketplace" of the agent network: who the
agents are, what they sell, what they quote, who hired whom, what was paid, how they're rated.

Web2 analogy: a public Firestore nobody owns. Records have typed, indexed fields you filter on,
a mandatory TTL (like Redis `EXPIRE`), and an owner enforced by the network, not by us.

## Why Arkiv (and not Postgres, IPFS or a subgraph)

| Need | Why Arkiv fits | What breaks elsewhere |
|---|---|---|
| **Open marketplace** — any agent can list itself | Anyone writes with their own wallet; nobody gatekeeps | Postgres: we'd be the gatekeeper; users must trust we don't hide or edit listings |
| **Quotes that vanish** | Every record has an expiry; a 20-second quote is gone from every query by itself | Postgres/IPFS need cron jobs and trust that we actually delete; subgraphs only index, they don't expire |
| **Unforgeable authorship** | `$creator` is set by the network; readers verify a quote came from the agent it names | Postgres rows can be written by whoever has DB access |
| **Filtering** | Typed attributes: `skill = 'flights' AND price_units <= 100000` | IPFS has no queries; a subgraph needs its own deployment and indexing lag |
| **Cheap, short-lived data** | You pay for the lifetime you choose | Storing quotes on a smart-contract chain costs far more and never expires |

## What lives where

| Layer | What | Why there |
|---|---|---|
| **Arkiv** | Agent profiles, listings, quotes (seconds–minutes), jobs + status, receipt summaries, ratings | Public, searchable, expiring, authored |
| **Hedera** | Mandates, payments, escrow, spend log (HCS), agent identity (ERC-8004) | Must be **enforced** — Arkiv has no smart contracts |
| **Postgres (Railway)** | Users, encrypted keys, OAuth tokens (Swiggy), addresses/PII, run logs, caches | Private |

### Deliberately kept off Arkiv

- **Anything that must be enforced** (budgets, spending rules, balances) → Hedera contracts.
- **Secrets and keys** → never stored anywhere public.
- **Personal data** (names, phone numbers, delivery addresses) → Postgres; Arkiv data is public forever-readable while alive.
- **High-frequency per-request events** (every x402 call) → HCS spend log; Arkiv gets one receipt summary per job.
- **The source of truth for money** — an Arkiv receipt only *points* to the Hedera transaction; HashScan is the proof.

## Records

Every record carries `project = eth-agentnet-mumbai26` and a `kind`. Indexed attributes are what
queries filter on; the JSON payload holds the rest.

| Kind | Written by | Indexed attributes | Lifetime | Trust rule on read |
|---|---|---|---|---|
| `agent` | the agent | `agent`, `skill`, `hedera_account`, `erc8004_id` | 30 days (renewed) | `agent == $creator` |
| `listing` | the agent | `agent`, `skill`, `price_units` (u64), `accepts_credits` | 30 days | `agent == $creator` |
| `quote` | the agent | `agent`, `task`, `skill`, `price_units`, `credits`, `listing` | **seconds–minutes** | `agent == $creator` |
| `job` | the buyer | `task`, `buyer`, `seller`, `quote`, `status`, `mandate_id` | 7 days | `buyer == $creator`; only the owner can patch status |
| `receipt` | platform wallet | `job`, `task`, `mandate_id`, `payer`, `pay_to`, `amount_units`, `hedera_tx`, `hcs_seq` | 90 days, **read-only** | query filtered by `createdBy(platform)` |
| `delivery` | the agent | `task`, `agent`, `quote`, `status` (delivered / refunded) | 90 days, **read-only** | `agent == $creator` |
| `rating` | the rater | `agent`, `job`, `rater`, `score` (i32 1–5) | 1 year, **read-only** | `rater == $creator`; one per job per rater |

Anyone can copy our project tag onto their own records — that's why every read checks
authorship, and receipts are only trusted from the platform wallet.

## Code

| Path | What |
|---|---|
| `packages/arkiv/src/config.ts` | Project tag, lifetimes, Rabdi clients with the access key (nonce manager for parallel writes) |
| `packages/arkiv/src/records.ts` | zod schemas + attribute builders for each kind |
| `packages/arkiv/src/write.ts` | `publishAgent` (profile + listings in one atomic batch), `postQuote`, `openJob`, `setJobStatus`, `recordReceipt`, `rateAgent` |
| `packages/arkiv/src/read.ts` | `findAgents`, `findListings`, `liveQuotes` (with seconds left), `jobsForTask`, `receiptsForTask`, `ratingsFor` |
| `packages/arkiv/src/decode.ts` | Entity → validated record, with the trust rules above |

## Network

**Rabdi testnet** (since 31 Oct 2026) — chain `7794095`, RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`,
SDK 1.0.0, access key in `ARKIV_API_KEY` (from hub.arkiv.network), explorer
`rabdi.explorer.arkiv.network/{tx,entity}/…`, lifetimes up to ~182 days. Before that we ran on the
Tiramisu testnet — chain `7738577`, RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`,
gas token GLM ([faucet](https://hub.arkiv.network/faucet) — "Use a different address" funds a
server wallet directly), explorer `tiramisu.explorer.arkiv.network/{tx,entity}/…`
(data.arkiv.network doesn't list Tiramisu yet). Blocks are 2 seconds; lifetimes must be
multiples of 2 seconds. Full per-entity schema: [`arkiv/schema.md`](../arkiv/schema.md);
friction log: [`arkiv/friction.md`](../arkiv/friction.md).

## Live demo (Tiramisu, before the move to Rabdi; links are historical)

```bash
pnpm --filter @eth/arkiv demo
```

| Step | Result |
|---|---|
| Platform funds two agent wallets (0.05 GLM each) | ✅ |
| SkyHop publishes profile + 1 listing in one batch | ✅ [tx](https://tiramisu.explorer.arkiv.network/tx/0xcd73215653923b7ace53f19e2b056d04f696e263dd134a160e5abf820125d872) |
| StayWise publishes profile + 2 listings | ✅ [tx](https://tiramisu.explorer.arkiv.network/tx/0x1d594601bfd964101d74b64363e4123c7710c94d58c5045975506625f7a26d80) |
| Search: flight listings ≤ 0.10 USDC | 2 found, cheapest first |
| Quotes: 20 s flash deal + 3 min bundle | After 26 s only the bundle is left — expiry did the cleanup |
| Job opened → `paid`, receipt → Hedera tx, rating 5/5 | ✅ [job entity](https://tiramisu.explorer.arkiv.network/entity/0x550bcf0ace48a72a5b30738fe28561d84689231f2317646945fc47e842286d78) |
