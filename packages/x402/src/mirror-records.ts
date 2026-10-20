import { z } from "zod";
import { type MirrorTx, MirrorTxSchema } from "./record-checks";

const ResponseSchema = z.object({ transactions: z.array(MirrorTxSchema) });

/** SDK id "0.0.5@1700000000.123456789" → mirror id "0.0.5-1700000000-123456789". */
export function toMirrorTxId(sdkId: string): string {
  const [account, time] = sdkId.split("@");
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
    for (let i = 0; i < attempts; i++) {
      const res = await fetchImpl(url);
      if (res.ok) {
        const { transactions } = ResponseSchema.parse(await res.json());
        if (transactions.length > 0) return transactions;
      } else if (res.status !== 404) {
        throw new Error(`mirror transactions → HTTP ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return [];
  };
}
