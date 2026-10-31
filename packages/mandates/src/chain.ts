import { defineChain } from "viem";

/** Hedera testnet as an EVM chain, reached through the Hashio JSON-RPC relay. */
export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
});

const env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env;

/**
 * Where our contracts live, per network. After a testnet reset the registry is redeployed
 * (`pnpm setup:testnet --fix`) and its new address set in .env (see docs/testnet-reset.md).
 */
export const DEPLOYMENTS = {
  testnet: {
    mandateRegistry: (env.MANDATE_REGISTRY_ADDRESS ||
      "0x2f30e8F1804Fe163C76918db493a441D44394D5d") as `0x${string}`,
    mandateRegistryId: env.MANDATE_REGISTRY_ID || "0.0.11102395",
  },
} as const;

/** HTS token id ("0.0.429274") → its ERC-20 facade address ("0x…068cda"). */
export function tokenIdToEvmAddress(tokenId: string): `0x${string}` {
  const num = Number(tokenId.split(".")[2]);
  if (!Number.isInteger(num)) throw new Error(`Bad token id: ${tokenId}`);
  return `0x${num.toString(16).padStart(40, "0")}`;
}
