import {
  type Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

/**
 * Hedera Consensus Service (HCS): public, append-only, timestamped logs.
 * We use topics as tamper-evident logs (spend-log, barter-ledger).
 * A submit key restricts who may write; anyone may read via the mirror node.
 */
export async function createTopic(
  client: Client,
  opts: { memo: string; submitKey: string },
): Promise<{ topicId: string; transactionId: string }> {
  const res = await new TopicCreateTransaction()
    .setTopicMemo(opts.memo)
    .setSubmitKey(PrivateKey.fromStringECDSA(opts.submitKey).publicKey)
    .execute(client);
  const receipt = await res.getReceipt(client);
  if (!receipt.topicId) throw new Error("Topic creation returned no topicId");
  return { topicId: receipt.topicId.toString(), transactionId: res.transactionId.toString() };
}

/** Appends one message to a topic. Returns its sequence number (1, 2, 3…). */
export async function submitMessage(
  client: Client,
  opts: { topicId: string; message: string | object; submitKey: string },
): Promise<{ sequence: number; transactionId: string }> {
  const body = typeof opts.message === "string" ? opts.message : JSON.stringify(opts.message);
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(opts.topicId)
    .setMessage(body)
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(opts.submitKey));
  const res = await tx.execute(client);
  const receipt = await res.getReceipt(client);
  return {
    sequence: Number(receipt.topicSequenceNumber ?? 0),
    transactionId: res.transactionId.toString(),
  };
}
