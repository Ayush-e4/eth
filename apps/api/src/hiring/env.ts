import { loadIdentities } from "@eth/agents/hiring";
import { NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, tokenIdToEvmAddress } from "@eth/mandates";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Who signs what when the concierge hires an agent:
 * - the concierge's own key signs each payment under a mandate (it's the mandate's `agent`)
 *   and owns the job records it writes on Arkiv;
 * - the demo wallet (the operator account) is the mandate owner for demo users, so they can
 *   try hiring without MetaMask. Wallet users own their mandates themselves.
 */
export interface HiringEnv {
  concierge: { key: Hex; evm: Address };
  demo: { key: Hex; evm: Address; account: string };
  mc: MandateClient;
  registry: Address;
  registryId: string;
  usdc: Address;
  usdcTokenId: string;
  mirrorUrl: string;
}

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

/** Null when the keys aren't there: chats still work, hiring just stays off. */
export function loadHiringEnv(env: NodeJS.ProcessEnv = process.env): HiringEnv | null {
  if (!env.HEDERA_ACCOUNT_ID || !env.HEDERA_PRIVATE_KEY) return null;
  let concierge: { key: Hex; evm: Address };
  try {
    concierge = loadIdentities().orchestrator;
  } catch {
    return null; // run `pnpm --filter @eth/agents identities` first
  }
  const net = NETWORKS.testnet;
  const demoKey = hex(env.HEDERA_PRIVATE_KEY);
  return {
    concierge,
    demo: {
      key: demoKey,
      evm: privateKeyToAccount(demoKey).address,
      account: env.HEDERA_ACCOUNT_ID,
    },
    mc: new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet),
    registry: DEPLOYMENTS.testnet.mandateRegistry,
    registryId: DEPLOYMENTS.testnet.mandateRegistryId,
    usdc: tokenIdToEvmAddress(net.usdcTokenId),
    usdcTokenId: net.usdcTokenId,
    mirrorUrl: net.mirrorUrl,
  };
}

/** The Hedera account behind an EVM address (MetaMask accounts get one when first funded). */
export async function hederaAccountOf(mirrorUrl: string, evm: Address): Promise<string | null> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${evm}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { account?: string };
  return body.account ?? null;
}
