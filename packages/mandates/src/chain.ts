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
 * v2 (pay on delivery) replaced v1; limits made on v1 stay readable and cancellable there.
 */
export const DEPLOYMENTS = {
  testnet: {
    mandateRegistry: (env.MANDATE_REGISTRY_ADDRESS ||
      "0xc854860e659d5e70fd4e47146643abec6db634b6") as `0x${string}`,
    mandateRegistryId: env.MANDATE_REGISTRY_ID || "0.0.11254658",
    /** Makes passkey wallets (Face ID controls them). */
    passkeyWalletFactory: (env.PASSKEY_WALLET_FACTORY ||
      "0x8ab68603de289c90b577d58b28f52365529347d1") as `0x${string}`,
    /** Makes v2 passkey wallets: one account, a passkey per device. New wallets come from here. */
    passkeyWalletFactoryV2: (env.PASSKEY_WALLET_FACTORY_V2 ||
      "0x560619a385a3e84281eae251b1276df8a5b835d4") as `0x${string}`,
    /** Registries we used before, oldest first: nothing new goes there. */
    previous: [
      {
        mandateRegistry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
        mandateRegistryId: "0.0.11102395",
      },
    ] as { mandateRegistry: `0x${string}`; mandateRegistryId: string }[],
  },
} as const;

/** HTS token id ("0.0.429274") → its ERC-20 facade address ("0x…068cda"). */
export function tokenIdToEvmAddress(tokenId: string): `0x${string}` {
  const num = Number(tokenId.split(".")[2]);
  if (!Number.isInteger(num)) throw new Error(`Bad token id: ${tokenId}`);
  return `0x${num.toString(16).padStart(40, "0")}`;
}
