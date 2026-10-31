import { loadIdentities } from "@eth/agents/hiring";
import { createClient, NETWORKS, type SpendLog, spendLog } from "@eth/hedera";
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
  /** The public spend log on Hedera (HCS); null when SPEND_LOG_TOPIC_ID isn't set. */
  log: SpendLog | null;
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
  const topicId = env.SPEND_LOG_TOPIC_ID;
  const log = topicId
    ? spendLog(
        createClient({
          network: "testnet",
          operatorId: env.HEDERA_ACCOUNT_ID,
          operatorKey: env.HEDERA_PRIVATE_KEY,
        }),
        topicId,
        env.HEDERA_PRIVATE_KEY, // the operator holds the topic's submit key, like the facilitator
      )
    : null;
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
    log,
  };
}

/** A client for the registry a saved limit lives on: the current one, or an older one. */
export function mandateClientFor(env: HiringEnv, registry: string): MandateClient {
  return registry.toLowerCase() === env.registry.toLowerCase()
    ? env.mc
    : new MandateClient(registry as Address, env.mc.chain);
}

/** The Hedera account behind an EVM address (MetaMask accounts get one when first funded). */
export async function hederaAccountOf(mirrorUrl: string, evm: Address): Promise<string | null> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${evm}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { account?: string };
  return body.account ?? null;
}
