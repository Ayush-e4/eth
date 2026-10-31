import { AccountId, type Client, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";

export interface TokenTransfer {
  tokenId: string;
  from: string;
  to: string;
  /** Amount in base units (USDC: 6 decimals, so 1 USDC = 1_000_000n). */
  units: bigint;
  /** Needed when `from` is not the operator account. */
  fromKey?: string;
  memo?: string;
}

/** Moves a token between two accounts in one atomic transaction. Returns the transaction ID. */
export async function transferToken(client: Client, t: TokenTransfer): Promise<string> {
  if (t.units <= 0n) throw new Error("Transfer amount must be positive");
  if (t.units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Transfer amount too large");
  const amount = Number(t.units);

  let tx = new TransferTransaction()
    .addTokenTransfer(t.tokenId, t.from, -amount)
    .addTokenTransfer(t.tokenId, t.to, amount)
    .setTransactionMemo(t.memo ?? "")
    .freezeWith(client);
  if (t.fromKey) tx = await tx.sign(PrivateKey.fromStringECDSA(t.fromKey));

  const res = await tx.execute(client);
  await res.getReceipt(client);
  return res.transactionId.toString();
}

/**
 * Sends HBAR from the operator to an account id ("0.0.x") or an EVM address ("0x…"). An EVM
 * address with no account yet gets one (a "hollow" account its key completes on first use).
 */
export async function transferHbar(
  client: Client,
  t: { from: string; to: string; hbar: number; memo?: string },
): Promise<string> {
  if (!(t.hbar > 0)) throw new Error("Transfer amount must be positive");
  const to = t.to.startsWith("0x") ? AccountId.fromEvmAddress(0, 0, t.to) : t.to;
  const res = await new TransferTransaction()
    .addHbarTransfer(t.from, new Hbar(-t.hbar))
    .addHbarTransfer(to, new Hbar(t.hbar))
    .setTransactionMemo(t.memo ?? "")
    .execute(client);
  await res.getReceipt(client);
  return res.transactionId.toString();
}
