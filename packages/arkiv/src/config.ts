import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { type Hex, http } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

/**
 * Every entity we write carries this project tag, and every query filters on it, so our data
 * never mixes with other apps on the shared Arkiv database (Arkiv best practice #1).
 */
export const PROJECT = "eth-agentnet-mumbai26";

/** How long each kind of record lives. Arkiv blocks are 2s; durations must be multiples of 2s. */
export const LIFETIME = {
  agent: () => ExpirationTime.fromDays(30),
  listing: () => ExpirationTime.fromDays(30),
  quote: (seconds = 180) => ExpirationTime.fromSeconds(seconds - (seconds % 2)),
  job: () => ExpirationTime.fromDays(7),
  receipt: () => ExpirationTime.fromDays(90),
  rating: () => ExpirationTime.fromDays(365),
  invoice: () => ExpirationTime.fromDays(30),
} as const;

export const ARKIV_CHAIN = tiramisu;
/** Tiramisu block explorer (data.arkiv.network does not list Tiramisu yet). */
export const ARKIV_EXPLORER = {
  tx: (hash: string) => `https://tiramisu.explorer.arkiv.network/tx/${hash}`,
  entity: (key: string) => `https://tiramisu.explorer.arkiv.network/entity/${key}`,
} as const;

/** Reads need no key and are safe anywhere. */
export function arkivReader(rpcUrl?: string) {
  return createPublicClient({ chain: tiramisu, transport: http(rpcUrl) });
}

/** Writes are signed by the given wallet; the nonce manager allows parallel writes from one process. */
export function arkivWriter(privateKey: Hex, rpcUrl?: string) {
  return createWalletClient({
    chain: tiramisu,
    transport: http(rpcUrl),
    account: privateKeyToAccount(privateKey, { nonceManager }),
  });
}

export type ArkivReader = ReturnType<typeof arkivReader>;
export type ArkivWriter = ReturnType<typeof arkivWriter>;
