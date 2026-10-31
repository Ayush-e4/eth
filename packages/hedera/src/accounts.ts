import {
  AccountCreateTransaction,
  type Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
} from "@hiero-ledger/sdk";

export interface NewAccount {
  accountId: string;
  evmAddress: string;
  /** Raw hex ECDSA private key. Store encrypted — never log it. */
  privateKey: string;
  transactionId: string;
}

/**
 * Creates a new account with a fresh ECDSA key (used for users and agents), or with an existing
 * key (`privateKey`): after a testnet reset that keeps an agent's EVM address, and so everything
 * it owns elsewhere (Arkiv listings, ERC-8004 identity), while giving it a new Hedera account.
 * The operator pays the fee and funds the initial HBAR balance.
 * ECDSA + alias means the account also has a normal EVM address (0x…),
 * so the same key can sign EIP-712 messages for our contracts.
 */
export async function createAccount(
  client: Client,
  opts: {
    initialHbar?: number;
    memo?: string;
    autoAssociations?: number;
    privateKey?: string;
  } = {},
): Promise<NewAccount> {
  const key = opts.privateKey
    ? PrivateKey.fromStringECDSA(opts.privateKey.replace(/^0x/, ""))
    : PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(new Hbar(opts.initialHbar ?? 1))
    .setMaxAutomaticTokenAssociations(opts.autoAssociations ?? 10)
    .setAccountMemo(opts.memo ?? "")
    .execute(client);
  const receipt = await tx.getReceipt(client);
  if (!receipt.accountId) throw new Error("Account creation returned no accountId");
  return {
    accountId: receipt.accountId.toString(),
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    privateKey: key.toStringRaw(),
    transactionId: tx.transactionId.toString(),
  };
}

/**
 * Opts an account in to holding a token (e.g. USDC). Required once per token
 * unless the account has free automatic-association slots.
 */
export async function associateToken(
  client: Client,
  accountId: string,
  accountKey: string,
  tokenId: string,
): Promise<string> {
  const tx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([tokenId])
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(accountKey));
  const res = await tx.execute(client);
  await res.getReceipt(client);
  return res.transactionId.toString();
}
