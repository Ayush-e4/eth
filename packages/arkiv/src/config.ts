import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
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
  rating: () => ExpirationTime.fromDays(180), // Rabdi caps lifetimes at ~182 days (7,884,000 blocks)
  invoice: () => ExpirationTime.fromDays(30),
  task: (seconds = 600) => ExpirationTime.fromSeconds(seconds - (seconds % 2)),
  claim: () => ExpirationTime.fromDays(7),
  delivery: () => ExpirationTime.fromDays(90),
} as const;

/**
 * Rabdi, Arkiv's testnet (it replaced Tiramisu in Oct 2026). The access key from
 * hub.arkiv.network rides in the RPC URL's path; without one we get the small public budget.
 */
export const ARKIV_CHAIN = rabdi({ accessKey: process.env.ARKIV_API_KEY ?? "" });
export const ARKIV_EXPLORER = {
  tx: (hash: string) => `https://rabdi.explorer.arkiv.network/tx/${hash}`,
  entity: (key: string) => `https://rabdi.explorer.arkiv.network/entity/${key}`,
} as const;

/** When the budget runs out the node answers 429: fail after one retry instead of backing off for minutes. */
const transport = () => http(undefined, { retryCount: 1, timeout: 15_000 });

/** Reads need no wallet and are safe anywhere. */
export function arkivReader() {
  return createPublicClient({ chain: ARKIV_CHAIN, transport: transport() });
}

/** Writes are signed by the given wallet; the nonce manager allows parallel writes from one process. */
export function arkivWriter(privateKey: Hex) {
  return createWalletClient({
    chain: ARKIV_CHAIN,
    transport: transport(),
    account: privateKeyToAccount(privateKey, { nonceManager }),
  });
}

export type ArkivReader = ReturnType<typeof arkivReader>;
export type ArkivWriter = ReturnType<typeof arkivWriter>;
