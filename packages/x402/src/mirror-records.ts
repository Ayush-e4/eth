import { z } from "zod";
import { type MirrorTx, MirrorTxSchema } from "./record-checks";

const ResponseSchema = z.object({ transactions: z.array(MirrorTxSchema) });

/**
 * SDK id "0.0.5@1700000000.123456789" → mirror id "0.0.5-1700000000-123456789". A scheduled
 * transaction's id ends in "?scheduled" and shares the mirror id with its ScheduleCreate.
 */
export function toMirrorTxId(sdkId: string): string {
  const [account, time] = sdkId.replace(/\?scheduled$/, "").split("@");
  if (!account || !time) throw new Error(`Bad transaction id: ${sdkId}`);
  return `${account}-${time.replace(".", "-")}`;
}

/**
 * Fetches the parent + child records of a transaction from the mirror node, retrying while
 * the mirror catches up with consensus (usually a few seconds).
 */
export function mirrorRecordFetcher(
  mirrorUrl: string,
  opts: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
) {
  const { attempts = 12, delayMs = 1500, fetchImpl = fetch } = opts;
  return async (transactionId: string): Promise<MirrorTx[]> => {
    const url = `${mirrorUrl}/api/v1/transactions/${toMirrorTxId(transactionId)}`;
    // For a scheduled payment the id also covers its ScheduleCreate: keep the scheduled call
    // and its children (the token transfer is a child), and wait until the call is there.
    // (The mirror's ?scheduled=true would drop those children.)
    const pick = transactionId.endsWith("?scheduled")
      ? (txs: MirrorTx[]) =>
          txs.some((t) => t.scheduled) ? txs.filter((t) => t.scheduled || t.nonce > 0) : []
      : (txs: MirrorTx[]) => txs;
    for (let i = 0; i < attempts; i++) {
      const res = await fetchImpl(url);
      if (res.ok) {
        const transactions = pick(ResponseSchema.parse(await res.json()).transactions);
        if (transactions.length > 0) return transactions;
      } else if (res.status !== 404) {
        throw new Error(`mirror transactions → HTTP ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return [];
  };
}
