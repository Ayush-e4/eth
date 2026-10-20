import { z } from "zod";
import { ERR } from "./types";

/**
 * Settlement proof for x402 `transferExecutor` (spec Phase 4, HTS assets).
 * Input is the mirror node's view of one transaction: the parent record plus child records
 * (a contract's token transfers appear only in children). We merge every transfer list and
 * require that exactly `amount` of `asset` moved from `payer` to `payTo`, the fee payer paid
 * only the network fee in HBAR, and nothing else moved at all.
 */

export const MirrorTxSchema = z.object({
  transaction_id: z.string(),
  result: z.string(),
  charged_tx_fee: z.number().optional().default(0),
  nonce: z.number().optional().default(0),
  transfers: z.array(z.object({ account: z.string(), amount: z.number() })).default([]),
  token_transfers: z
    .array(z.object({ token_id: z.string(), account: z.string(), amount: z.number() }))
    .default([]),
  nft_transfers: z.array(z.unknown()).default([]),
});

export type MirrorTx = z.infer<typeof MirrorTxSchema>;

export interface SettlementExpectation {
  payer: string;
  payTo: string;
  asset: string; // HTS token id
  amount: bigint;
  feePayer: string;
}

export type SettlementVerdict =
  | { ok: true; fee: bigint }
  | { ok: false; reason: string; detail: string };

function addTo(map: Map<string, bigint>, key: string, amount: number) {
  map.set(key, (map.get(key) ?? 0n) + BigInt(amount));
}

export function checkSettlement(txs: MirrorTx[], e: SettlementExpectation): SettlementVerdict {
  const fail = (reason: string, detail: string): SettlementVerdict => ({
    ok: false,
    reason,
    detail,
  });
  if (txs.length === 0) return fail(ERR.settlementPending, "no records yet");

  const failed = txs.find((t) => t.result !== "SUCCESS");
  if (failed) return fail(ERR.statusNotSuccess, `record nonce ${failed.nonce}: ${failed.result}`);

  if (txs.some((t) => t.nft_transfers.length > 0)) {
    return fail(ERR.unexpectedTransfer, "an NFT changed owner");
  }

  // ── Token movements: only `asset`, only payer → payTo, exactly `amount` ──
  const tokens = new Map<string, bigint>(); // "token|account" → net
  for (const t of txs)
    for (const tt of t.token_transfers) addTo(tokens, `${tt.token_id}|${tt.account}`, tt.amount);

  for (const [key, net] of tokens) {
    if (net === 0n) continue;
    const [token, account] = key.split("|") as [string, string];
    if (token !== e.asset)
      return fail(ERR.unexpectedTransfer, `token ${token} moved for ${account}`);
    if (account === e.payTo || account === e.payer) continue;
    return net < 0n
      ? fail(ERR.unexpectedDebit, `${account} lost ${-net} of ${token}`)
      : fail(ERR.unexpectedTransfer, `${account} received ${net} of ${token}`);
  }
  const credited = tokens.get(`${e.asset}|${e.payTo}`) ?? 0n;
  if (credited !== e.amount) {
    return fail(ERR.payeeCreditMismatch, `payTo credited ${credited}, expected ${e.amount}`);
  }
  const debited = -(tokens.get(`${e.asset}|${e.payer}`) ?? 0n);
  if (debited !== e.amount) {
    return fail(ERR.payerDebitMismatch, `payer debited ${debited}, expected ${e.amount}`);
  }

  // ── HBAR: the fee payer pays the fee; nobody else loses HBAR ──
  const hbar = new Map<string, bigint>();
  for (const t of txs) for (const h of t.transfers) addTo(hbar, h.account, h.amount);
  const fee = txs.reduce((sum, t) => sum + BigInt(t.charged_tx_fee), 0n);

  for (const [account, net] of hbar) {
    if (net < 0n && account !== e.feePayer) {
      return fail(ERR.unexpectedDebit, `${account} lost ${-net} tinybars`);
    }
  }
  const feePaid = -(hbar.get(e.feePayer) ?? 0n);
  if (feePaid !== fee) {
    return fail(ERR.feePayerDebitMismatch, `fee payer debited ${feePaid}, record fee ${fee}`);
  }
  const credits = [...hbar.values()].filter((v) => v > 0n).reduce((a, b) => a + b, 0n);
  if (credits !== fee) {
    return fail(ERR.unexpectedTransfer, `HBAR credits ${credits} ≠ fee ${fee}`);
  }

  return { ok: true, fee };
}
