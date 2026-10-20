import { type Client, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";

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
