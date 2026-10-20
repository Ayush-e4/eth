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
| `packages/contracts/src/MandateRegistry.sol` | The contract |
| `packages/contracts/src/mandate/IMandateRegistry.sol` | Structs, events, errors |
| `packages/contracts/src/mandate/MandateSignatures.sol` | EIP-712 hashing + signature checks |
| `packages/contracts/test/mandate/*.t.sol` | 54 tests: create, pay, sub-mandates, revoke, x402, fuzz, invariants |
| `packages/mandates/src/` | TypeScript client: ABI, signing, `MandateClient` |
| `packages/mandates/scripts/demo.ts` | Live testnet walkthrough |

Invariants (checked over 128,000 random calls): a mandate never spends + delegates more than
its budget; the owner loses exactly what was paid; the registry never holds funds; only
allowed payees ever receive money.

## Deployment (Hedera testnet)

- `MandateRegistry`: `0x2f30e8F1804Fe163C76918db493a441D44394D5d` (`0.0.11102395`)
- Admin key is the contract itself — no external party can modify it.

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
