import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { type HederaConfig, NETWORKS } from "./config";

/**
 * A Hedera client that signs and pays for transactions as the operator account.
 * The operator is our "server" account from .env.
 */
export function createClient(config: HederaConfig): Client {
  const client = config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(config.operatorId),
    PrivateKey.fromStringECDSA(config.operatorKey),
  );
  return client;
}

export function networkInfo(config: HederaConfig) {
  return NETWORKS[config.network];
}

/** Public receipt link for a transaction, e.g. to show judges. */
export function hashscanTxUrl(config: HederaConfig, transactionId: string): string {
  return `${NETWORKS[config.network].hashscanUrl}/transaction/${transactionId}`;
}

export function hashscanAccountUrl(config: HederaConfig, accountId: string): string {
  return `${NETWORKS[config.network].hashscanUrl}/account/${accountId}`;
}
