import { getAddress, isAddress } from "viem";
import { z } from "zod";

/** Hedera testnet's EVM chain id; sign-in messages must name it. */
export const HEDERA_TESTNET_CHAIN_ID = 296;

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().default("postgres://eth:eth@127.0.0.1:54329/eth"),
  // The web app's origin: CORS allows it, and sign-in messages must come from it.
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  // Who gets the admin role (the ops page): comma-separated wallet addresses, and/or account ids
  // (passkey accounts have no wallet address; the ops page shows yours).
  ADMIN_WALLETS: z.string().default(""),
  ADMIN_USERS: z.string().default(""),
  // "Try the demo" sign-in without MetaMask.
  DEMO_MODE: z.enum(["on", "off"]).default("on"),
});

export interface Config {
  production: boolean;
  port: number;
  databaseUrl: string;
  appOrigin: string;
  /** host[:port] the sign-in message's domain must equal. */
  siweDomain: string;
  admins: ReadonlySet<string>;
  adminUsers: ReadonlySet<string>;
  demoMode: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const admins = e.ADMIN_WALLETS.split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      if (!isAddress(a)) throw new Error(`ADMIN_WALLETS has an invalid address: ${a}`);
      return getAddress(a);
    });
  return {
    production: e.NODE_ENV === "production",
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    siweDomain: new URL(e.APP_ORIGIN).host,
    admins: new Set(admins),
    adminUsers: new Set(
      e.ADMIN_USERS.split(",")
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    ),
    demoMode: e.DEMO_MODE === "on",
  };
}
