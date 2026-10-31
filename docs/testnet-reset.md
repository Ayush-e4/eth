# After a testnet reset

Hedera's testnet is wiped from time to time (accounts, contracts and topics are gone), and
Arkiv's testnets change too (Tiramisu became Rabdi in Oct 2026). This runbook gets AgentNet
back in a few minutes, most of it automatic.

```bash
pnpm setup:testnet          # check everything, change nothing
pnpm setup:testnet --fix    # fix what can be fixed, then list what needs a person
```

It checks, in order (later steps need the earlier ones):

| Step | Fixed automatically? | If not, what to do |
|---|---|---|
| Operator account (pays fees, is the demo wallet) | no | Create an ECDSA testnet account at portal.hedera.com; set `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY` in `.env`; HBAR from the portal |
| Test USDC (Circle) | lets the operator hold it | Get test USDC at faucet.circle.com. If Circle's token id changed, set `USDC_TOKEN_ID` |
| MandateRegistry (our spending-limit contract) | **redeploys it** from `forge build` output | Add the printed `MANDATE_REGISTRY_ADDRESS` and `MANDATE_REGISTRY_ID` to `.env` |
| Public spend log (HCS topic) | **creates a new topic** | Add the printed `SPEND_LOG_TOPIC_ID` to `.env` |
| Agent accounts | **recreates them with the same keys** | — |
| Arkiv: GLM for everyone who writes | no | Fund the listed addresses at hub.arkiv.network (Rabdi faucet) |
| ERC-8004 identities (official registry, not ours) | **re-registers** agents | Agents must be listed first: run `pnpm --filter @eth/agents serve` once, then `--fix` again |

Then restart the market (`pnpm --filter @eth/agents serve`) and the API: agents relist themselves
on Arkiv at start and renew their listings from then on.

## Why agents keep their keys

An agent's key is its identity everywhere: it owns its Arkiv listings and its ERC-8004 identity,
and buyers check signatures against it. A reset only removes its *Hedera account*, so the script
creates a new account for the **same key**. The agent keeps its EVM address, and with it its
listings, reviews and identity. Only the `hederaAccount` in `apps/agents/.agents.local.json`
changes.

## What a reset loses for good

- Old spending limits, payments and the old spend log (they were on the wiped network). Chats
  still show their history; their links to HashScan stop working.
- Users' own testnet accounts: wallet users create new ones in MetaMask.

## Tested

The check passes on the live testnet (Oct 31 2026). The two risky fixes were run for real: a
spare MandateRegistry deployed from the build output (`0.0.11254136`, 8,783 bytes of code), and
an account created from a given key (`0.0.11254192`) kept that key's EVM address.
