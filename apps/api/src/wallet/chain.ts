import {
  type Assertion,
  DEPLOYMENTS,
  erc20Abi,
  hederaTestnet,
  type KeySig,
  type PasskeyKey,
  PasskeyWalletClient,
  type WalletCall,
} from "@eth/mandates";
import { type Address, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { HiringEnv } from "../hiring/env";
import { hederaAccountOf } from "../hiring/env";

/** What the wallet service needs from Hedera (a fake in tests). */
export interface WalletChain {
  version: 1 | 2; // which PasskeyWallet it makes
  addressOf(k: PasskeyKey): Promise<Address>;
  create(k: PasskeyKey): Promise<Address>;
  hederaIdOf(wallet: Address): Promise<string | null>;
  gift(to: Address, units: bigint): Promise<Hex>;
  balanceOf(wallet: Address): Promise<bigint>;
  digest(wallet: Address, calls: WalletCall[], deadline: bigint): Promise<Hex>;
  execute(
    wallet: Address,
    calls: WalletCall[],
    deadline: bigint,
    sig: Assertion | KeySig, // v2 wallets: with which of their passkeys signed
    gas?: bigint,
  ): Promise<{ hash: Hex; mandateId?: bigint }>;
}

/**
 * The real thing. The demo wallet (the operator) sends every transaction and pays its gas,
 * and gives new wallets their free test USDC; it can't move anything a wallet holds. New
 * wallets are v2 (a passkey per device); v1 wallets keep working through `execute`.
 */
export function hederaWalletChain(
  env: HiringEnv,
  factory: Address = DEPLOYMENTS.testnet.passkeyWalletFactoryV2,
): WalletChain {
  const relayer = privateKeyToAccount(env.demo.key);
  const client = new PasskeyWalletClient(factory);
  const writer = createWalletClient({ account: relayer, chain: hederaTestnet, transport: http() });
  return {
    version: 2,
    addressOf: (k) => client.addressOf(k),
    create: (k) => client.create(relayer, k, env.usdc),
    hederaIdOf: (wallet) => hederaAccountOf(env.mirrorUrl, wallet),
    async gift(to, units) {
      const hash = await writer.writeContract({
        address: env.usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, units],
      });
      const r = await client.publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`gift failed: ${hash}`);
      return hash;
    },
    balanceOf: (wallet) =>
      client.publicClient.readContract({
        address: env.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
    digest: (wallet, calls, deadline) => client.digest(wallet, calls, deadline),
    execute: (wallet, calls, deadline, sig, gas) =>
      client.execute(relayer, wallet, calls, deadline, sig, gas),
  };
}
