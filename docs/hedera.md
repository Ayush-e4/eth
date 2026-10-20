# Hedera foundation

How we use Hedera, and what we verified on testnet before building on it.

## Pieces we use

| Hedera feature | Web2 analogy | Our use |
|---|---|---|
| Accounts (`0.0.x`) + ECDSA keys | Bank account + password | One per user and per agent |
| HBAR | API credits for fees | Network fees |
| HTS token (USDC `0.0.429274`) | Built-in currency | Agent payments |
| Token association | Enabling a currency on a card | Accounts opt in to USDC once |
| HCS topics | Append-only Kafka topic nobody can edit | `spend-log`, `barter-ledger` |
| Smart contracts (EVM) | Public, unchangeable backend code | MandateRegistry |
| Mirror node REST | Read replica | Balances, messages (AccountBalanceQuery is deprecated since v0.77) |
| Hashio JSON-RPC | Ethereum-compatible API gateway | Deploy/call Solidity with Foundry and viem |

## Package: `@eth/hedera`

| File | Purpose |
|---|---|
| `config.ts` | Validates `.env`; errors name the field, never its value |
| `client.ts` | Testnet client as the operator; HashScan links |
| `mirror.ts` | Balances and topic messages via mirror REST |
| `accounts.ts` | Create ECDSA accounts (users, agents); associate tokens |
| `payments.ts` | Atomic token transfers |
| `hcs.ts` | Create topics with a submit key; append messages |
| `units.ts` | Exact USDC (6 dp) and HBAR conversions with bigint |

Scripts (need `.env`, run locally — not in CI):

```bash
pnpm --filter @eth/hedera account          # balances + HashScan link
pnpm --filter @eth/hedera associate-usdc   # one-time USDC opt-in
pnpm --filter @eth/hedera hcs-demo         # create topic, write, read back
pnpm --filter @eth/hedera pay-demo         # new agent account, pay it 0.10 USDC
pnpm --filter @eth/hedera probe-check <probe> <recipient>   # contract feasibility checks
```

## Feasibility results (testnet, Oct 2026)

The MandateRegistry design depends on two things. Both pass.

| Check | How | Result |
|---|---|---|
| Contract verifies an agent's EIP-712 signature | Sign `PaymentAuth` off-chain with viem; `HederaProbe.recoverSigner` via `eth_call` | **PASS** — recovered the signer's exact address |
| Contract moves USDC the owner approved | `approve()` on USDC's ERC-20 facade (`0x…068cda`), then `HederaProbe.pull()` → `transferFrom` | **PASS** — recipient +0.05 USDC |

- Probe contract: `0x4124E13ed637b7bbd9bA80f87A538E896446c696` (testnet)
- Pull transaction: [HashScan](https://hashscan.io/testnet/transaction/0x60ba90e7f37c8d379ee624f6e81eefb28ed854c624cb999a648d5fc4a0677bf3)

`HederaProbe` is a throwaway probe, not product code. MandateRegistry will build on these results.

## Gotchas found

- Use **ECDSA** keys (not ED25519): the same key then signs Hedera transactions and EIP-712 messages.
- Read balances from the **mirror node**; `AccountBalanceQuery` is deprecated.
- The mirror node lags consensus by a few seconds — poll briefly after writes.
- HTS tokens have an EVM address: `0x` + token number in hex, left-padded to 40 chars.
- `foundryup` hung on macOS here; Foundry installs fine via `brew install foundry`.
