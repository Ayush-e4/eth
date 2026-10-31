# MandateRegistry — onchain spending mandates

An owner gives an agent a **mandate**: a budget, a per-payment cap, an expiry and an optional
payee allowlist. The agent authorises each payment with an EIP-712 signature; the contract
checks every rule and only then pulls exactly that amount from the owner to the payee.

Web2 analogy: a UPI AutoPay mandate or a corporate card with spend rules — except the rules
are enforced by public code nobody (not even us) can change or bypass.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Where funds sit | **Owner's account** (option A). Registry pulls via ERC-20 allowance. | Owner keeps custody; registry never holds a pool, so a bug can't drain one. Escrow holds come later with pay-on-delivery. |
| Who submits payments | Anyone (a relayer, our backend). The agent's signature is what authorises. | Agents never need HBAR for gas. |
| Sub-mandates | Parent agent signs; budget is **carved out** of the parent; limits only get tighter | Agents can hire agents without ever exceeding the owner's budget. |
| Revocation | Flag on the mandate; payments check **every ancestor** | One revoke stops the whole tree, including authorisations already signed. |
| Replay | Single-use nonce per mandate + `validBefore` | Each signed payment works once, briefly. |
| Upgradability | None, no admin | Rules can't change under users; preferred by x402 for executors. |
| x402 | Implements `executeTransfer` (selector `0xea8f19fd`) | An x402 facilitator can settle through the registry (next feature). |

## Rules checked on every payment

1. Mandate exists, and it and all ancestors are not revoked and not expired
2. Authorisation not expired (`validBefore`) and nonce unused
3. Signature is from the mandate's agent (EOA or ERC-1271)
4. `amount > 0` and `amount ≤ perPaymentCap`
5. `spent + delegated + amount ≤ budget`
6. Payee is on the allowlist (if the mandate restricts payees)
7. Then: record `spent`, emit `Paid`, `transferFrom(owner → payee)`

## Files

| Path | What |
|---|---|
| `packages/contracts/src/MandateRegistry.sol` | The contract: create, pay directly, revoke |
| `packages/contracts/src/mandate/MandateStore.sol` | Storage, views, and the checks every payment shares |
| `packages/contracts/src/mandate/MandateEscrow.sol` | Pay on delivery (v2) |
| `packages/contracts/src/mandate/IMandateRegistry.sol` | Structs, events, errors |
| `packages/contracts/src/mandate/MandateSignatures.sol` | EIP-712 hashing + signature checks |
| `packages/contracts/test/mandate/*.t.sol` | 65 tests: create, pay, escrow, sub-mandates, revoke, x402, fuzz, invariants |
| `packages/mandates/src/` | TypeScript client: ABI, signing, `MandateClient`, `EscrowClient` |
| `packages/mandates/scripts/demo.ts` | Live testnet walkthrough |
| `packages/mandates/scripts/escrow-demo.ts` | Live pay-on-delivery walkthrough |
| `packages/mandates/scripts/deploy-registry.ts` | Deploy a registry and let it hold test USDC |

Invariants (checked over 128,000 random calls, escrow included): a mandate never spends +
delegates more than its budget; the owner loses exactly what was paid out or is still held; the
registry holds exactly what's in open escrows (nothing else, nothing stuck); only allowed payees
ever receive money.

## Pay on delivery (v2)

A payment can wait in the registry until the job is done, instead of going straight to the
payee. It passes exactly the same checks (one shared `_authorize`), and the agent's EIP-712
`EscrowAuth` signs the terms too, so nobody can stretch them:

| Move | Who | When |
|---|---|---|
| `executeEscrowTransfer` / `payIntoEscrow` | the facilitator / anyone, with the agent's signature | money goes into the registry, `Held` |
| `markDelivered(id, resultHash)` | the payee | before `deliverBy`; records a hash of what it delivered |
| `release` | the buyer (mandate agent or owner) | any time before it's paid out |
| `claim` | anyone (the payee) | `reviewSeconds` after delivery, if not disputed |
| `dispute` | the buyer | within the review window: frozen until refund or release |
| `refund` | the payee | any time before it's paid out; **the budget comes back** |
| `reclaim` | anyone | not delivered by `deliverBy`: back to the payer |

Hedera detail: an account (a contract too) must opt in to each token, so the registry calls the
token service precompile once (`associate(USDC)`; `deploy-registry` does it). The escrow id is
`keccak256(abi.encode(mandateId, nonce))`, so it follows from the payment itself.

## Deployment (Hedera testnet)

- `MandateRegistry` v2 (pay on delivery), **in use**: `0xc854860e659d5e70fd4e47146643abec6db634b6` (`0.0.11254658`)
- `MandateRegistry` v1, retired: `0x2f30e8F1804Fe163C76918db493a441D44394D5d` (`0.0.11102395`)

Each registry numbers its limits from 1, so the app saves every limit and hire with the registry
it lives on. Limits made on v1 still show on the Wallet page (marked "older contract") and can
still be cancelled there, but new hires only use limits on v2: a chat whose limit is on v1 is
simply asked for a new one. The MCP server's limit lives on one registry too: after the switch
it says so on start; run `pnpm --filter @eth/mcp setup-mandate` again.
- Admin key is the contract itself — no external party can modify it.

## Live pay-on-delivery result (testnet, v2)

```
pnpm --filter @eth/mandates escrow-demo
```

| Step | Result |
|---|---|
| Limit #1 on v2: 0.10 USDC, only to a fresh payee | ✅ |
| Agent-signed 0.02 USDC into escrow: the registry holds it, not the payee | ✅ [HashScan](https://hashscan.io/testnet/transaction/0xccf220fff45b9265819ae03ec2fbf5a6701d86df848e79aede79bd87ce560182) |
| Payee marks it delivered (with a result hash) | ✅ [HashScan](https://hashscan.io/testnet/transaction/0x4ca2fbd87888a0cce529fb770c75ab2a813586fd3cb2cc0aa2478b47d2a2a940) |
| Buyer releases: payee gets exactly 0.02, registry back to 0 | ✅ [HashScan](https://hashscan.io/testnet/transaction/0x2ac21e14baf5d8cd886ed611d845071f9f8bc7fcf5b6cf5db5145bfc7ccbbc00) |
| 0.01 into escrow for a job that fails; payee refunds | ✅ [HashScan](https://hashscan.io/testnet/transaction/0x7e169897179ca389d44f51d24dd3c737f21391442e5c8dfe57e410568331f7e6) |
| The refund comes back to the limit: 0.08 of 0.10 left | ✅ |

## Live demo result (testnet)

```
pnpm --filter @eth/mandates demo
```

| Step | Result |
|---|---|
| Approve registry, create mandate #1 (1 USDC, cap 0.5, airline only) | ✅ |
| Trip agent pays airline 0.3 USDC | ✅ [HashScan](https://hashscan.io/testnet/transaction/0x9dd654bea27f03a95a0543bad9a7948fbb36a4268f6d1fecd37a7e7ac5715a37) |
| 0.6 USDC (over cap) | ❌ `OverPaymentCap` |
| Pay an unknown address | ❌ `PayeeNotAllowed` |
| Signed 0.1, submitted 0.4 | ❌ `BadSignature` |
| Replay a used authorisation | ❌ `NonceUsed` |
| Signed by a stranger | ❌ `BadSignature` |
| Sub-mandate #2 for flights agent (0.4 carved from #1), pays 0.2 | ✅ |
| Owner revokes #1 → flights agent pays | ❌ `MandateInactive` |

## Known limits (by design, for now)

- Budget is permission, not reserved money: if the owner spends the USDC elsewhere, payments fail.
  The app will check balance + allowance before starting work.
- Unspent sub-mandate budget isn't returned to the parent on revoke (could add `reclaim` later).
