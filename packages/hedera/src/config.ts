import { z } from "zod";

/** Hedera network settings, read from environment variables (see repo-root .env). */
const EnvSchema = z.object({
  HEDERA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HEDERA_ACCOUNT_ID: z.string().regex(/^0\.0\.\d+$/, "expected 0.0.<number>"),
  HEDERA_PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "expected 32-byte hex ECDSA key"),
  HEDERA_EVM_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional()
    .or(z.literal("")),
});

export type HederaNetwork = "testnet" | "mainnet";

export interface HederaConfig {
  network: HederaNetwork;
  operatorId: string;
  operatorKey: string;
  operatorEvmAddress?: string;
}

/** Well-known addresses per network. */
export const NETWORKS = {
  testnet: {
    mirrorUrl: "https://testnet.mirrornode.hedera.com",
    jsonRpcUrl: "https://testnet.hashio.io/api",
    hashscanUrl: "https://hashscan.io/testnet",
    /** Circle USDC on Hedera testnet (6 decimals). Faucet: https://faucet.circle.com */
    usdcTokenId: "0.0.429274",
  },
  mainnet: {
    mirrorUrl: "https://mainnet.mirrornode.hedera.com",
    jsonRpcUrl: "https://mainnet.hashio.io/api",
    hashscanUrl: "https://hashscan.io/mainnet",
    usdcTokenId: "0.0.456858",
  },
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HederaConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid Hedera env:\n  ${fields.join("\n  ")}`);
  }
  const e = parsed.data;
  return {
    network: e.HEDERA_NETWORK,
    operatorId: e.HEDERA_ACCOUNT_ID,
    operatorKey: e.HEDERA_PRIVATE_KEY,
    operatorEvmAddress: e.HEDERA_EVM_ADDRESS || undefined,
  };
}
