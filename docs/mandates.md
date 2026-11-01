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

### In the app (31 Oct 2026)

Hires from the chat now pay on delivery (see [agent-jobs.md](agent-jobs.md#pay-on-delivery-escrow)):

| Run | Result |
|---|---|
| PackPal, packing list for Shimla: 0.01 USDC held, delivered, released by the concierge (log #109) | ✅ [held](https://hashscan.io/testnet/transaction/0.0.11045937@1793461739.799518124) · [delivered](https://hashscan.io/testnet/transaction/0.0.11254401@1793461804.809433205) · [paid out](https://hashscan.io/testnet/transaction/0xff61f291b0fb5aeff4cc24af972919893abe6d4be3f6ef3beaf8ea579a4d5f88) |
| AirNest, sandbox flight booking FH-26A-H7STB88W: 0.03 USDC held, delivered, paid out (log #114) | ✅ |
| A job that fails on purpose: the agent refunds from escrow, the limit is back to 0.26 | ✅ [refund](https://hashscan.io/testnet/transaction/0.0.11254401@1793461923.449036148) |
| **Dispute** from the chat (Goa list, log #117): frozen on-chain, PackPal refunded it within a minute, the timer never paid | ✅ [refund](https://hashscan.io/testnet/transaction/0.0.11254401@1793463029.417597771) |
| **Looks good, pay now** (Darjeeling, log #120): paid out at once | ✅ [paid out](https://hashscan.io/testnet/transaction/0x331847b549f1e3612d765a7b87e401bc111c4314012f1f46fd24d2d0cba56e36) |
| No click (Pune, log #123): paid out when the 2-minute review ended | ✅ [paid out](https://hashscan.io/testnet/transaction/0x7e29bb569ab0c3bd4a43aefe753e348d3198f65e81cd7a44c0fdf2f39e1fc155) |

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

## Passkey wallets (Face ID controls the wallet)

Web2 analogy: a bank account whose only "password" is your face. A passkey (Face ID, a
fingerprint, a phone) is a P-256 key pair kept by the device. `PasskeyWallet` is a small contract
that holds USDC and runs a batch of calls only with that passkey's signature over exactly that
batch, this wallet, chain 296, its current nonce and a deadline. Anyone can submit the batch (our
server does and pays the gas); nobody can change it. So a spending limit is "approve USDC +
`createMandate`" signed with Face ID: the wallet becomes the mandate's owner, and the registry
pulls fees from it like from any owner. The registry didn't change.

- **On-chain WebAuthn check** (`src/wallet/PasskeySignature.sol`): type is `webauthn.get`, the
  challenge is the batch digest, user present and verified (biometric, not just a tap), P-256
  signature. Hedera has no P-256 precompile (RIP-7212), so it calls OpenZeppelin's
  pure-Solidity verifier directly (`P256.verifySolidity`; `P256.verify` would probe 0x100
  first). The app flips a high `s` to low before sending.
- **`PasskeyWalletFactory`** makes one wallet per passkey at a CREATE2 address derived from the
  public key, and opts it in to USDC through the HTS precompile (Hedera accounts must associate
  a token before holding it). Permissionless: the wallet answers only to its passkey.
- **ERC-1271** `isValidSignature`, so contracts can accept the passkey's signature as the wallet's.
- No admin, not upgradeable. v1 has one passkey; v2 (below) takes one per device.
- Client: `PasskeyWalletClient`, `assertionFromWebAuthn`, `limitCalls`, `revokeCalls` in
  `packages/mandates/src/passkey-wallet.ts`.

Deployed: factory `0x8ab68603de289c90b577d58b28f52365529347d1`
(`pnpm --filter @eth/mandates deploy-wallet-factory`; override with `PASSKEY_WALLET_FACTORY`).

Live run (`pnpm --filter @eth/mandates passkey-wallet-demo`, a software passkey standing in for
Face ID), 2026-11-01:

| Step | Result |
|---|---|
| Make the wallet, opted in to USDC | [0xC034A996…6462](https://hashscan.io/testnet/contract/0xC034A9969D87EF422728F8661115C069719F6462) |
| Passkey sets a 0.05 USDC limit (approve + create, one batch) | [mandate #9, owner = wallet](https://hashscan.io/testnet/transaction/0x846d2f45fe95223c15daf90b8493bc023769163b2a723e27ae8d41910c0263fa) (≈1.2M gas) |
| Agent paid 0.01 USDC out of the wallet | [tx](https://hashscan.io/testnet/transaction/0xd2565ebe82e686235b57c27caa66288d5e8ab1958b8de89e1eac01c8a946248f) |
| Passkey cancels the limit | [tx](https://hashscan.io/testnet/transaction/0x6fe2b86770cd0e5c1d761a2dcfd97318a0771b2a2a6a940eeb2bc1d4d27cb6ee) (≈0.3M gas) |

### v2: one account, a passkey per device

Passkeys don't always sync between devices (a work laptop, a second phone, another browser), so
one passkey per wallet meant one account per device. `PasskeyWalletV2` keeps a set of trusted
passkeys instead. A batch names which passkey signed it (`KeySig {qx, qy, sig}`) and runs if that
passkey is in the set and the signature checks out. Adding or removing a passkey is itself a batch
(a call from the wallet to `addKey` / `removeKey`), so only a device it already trusts can let
another one in, and a lost one is shut out the same way. The last passkey can't be removed
(`LastKey`). Same digest, factory interface and ERC-1271 as v1 (the signature is an abi-encoded
`KeySig`). Wallets made with v1 stay single-passkey.

- Client: `addKeyCalls`, `removeKeyCalls`, `hasKey`, and `execute` taking a `KeySig` for v2.
- Deployed: factory v2 `0x560619a385a3e84281eae251b1276df8a5b835d4`
  (`pnpm --filter @eth/mandates deploy-wallet-factory v2`; override with
  `PASSKEY_WALLET_FACTORY_V2`).

Live run (`pnpm --filter @eth/mandates multi-device-demo`, two software passkeys as "phone" and
"laptop"), 2026-11-02:

| Step | Result |
|---|---|
| Phone's passkey makes the wallet | [0xC6C6e2c7…BD1B](https://hashscan.io/testnet/contract/0xC6C6e2c7B9A8971e00C4D5dDE0f9f01029BABD1B) |
| Laptop sets a limit on its own | ❌ `NotAKey` |
| Phone lets the laptop in | [tx](https://hashscan.io/testnet/transaction/0x00fd4ab2d69cbbca7a4612562b45730599fb1f8cfd75586b83e0eae524895df0) |
| Laptop sets a 0.02 USDC limit | [mandate #14, owner = wallet](https://hashscan.io/testnet/transaction/0x7bd54b6c9980e739edeff1b0fc2e6fc9d2279c9abef7acaf8669e375986eedfd) |
| Phone shuts the laptop out | [tx](https://hashscan.io/testnet/transaction/0x29891d40c7bd612cf9befd89a31d69f773a68eae77322285d8284dd70b498895) |
| Laptop cancels the limit | ❌ `NotAKey` |
| Phone cancels it | [tx](https://hashscan.io/testnet/transaction/0x2c9812a75701dc8d8e708d84abec75a8b9125cc21b13b131b35caea0ef0c970a) |

## Known limits (by design, for now)

- Budget is permission, not reserved money: if the owner spends the USDC elsewhere, payments fail.
  The app will check balance + allowance before starting work.
- Unspent sub-mandate budget isn't returned to the parent on revoke (could add `reclaim` later).
