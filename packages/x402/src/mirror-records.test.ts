import { describe, expect, it } from "vitest";
import { mirrorRecordFetcher, toMirrorTxId } from "./mirror-records";
import { checkSettlement } from "./record-checks";

const OP = "0.0.11045937";
const SHOP = "0.0.11116757";
const USDC = "0.0.429274";
const fee = (n: number) => [
  { account: OP, amount: -n },
  { account: "0.0.98", amount: n },
];

// What the mirror returned for a real undo-window payment: the ScheduleCreate, the scheduled
// contract call, and the call's child token transfer, all under one transaction id.
const family = {
  transactions: [
    {
      transaction_id: "x",
      result: "SUCCESS",
      nonce: 0,
      scheduled: false,
      charged_tx_fee: 5,
      transfers: fee(5),
    },
    {
      transaction_id: "x",
      result: "SUCCESS",
      nonce: 0,
      scheduled: true,
      charged_tx_fee: 7,
      transfers: fee(7),
    },
    {
      transaction_id: "x",
      result: "SUCCESS",
      nonce: 1,
      scheduled: false,
      token_transfers: [
        { token_id: USDC, account: OP, amount: -30000 },
        { token_id: USDC, account: SHOP, amount: 30000 },
      ],
    },
  ],
};

describe("mirror records for a scheduled payment", () => {
  it("keeps the scheduled call and its child transfer, not the ScheduleCreate", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      return Response.json(family);
    }) as unknown as typeof fetch;
    const txs = await mirrorRecordFetcher("https://m", { fetchImpl })(
      `${OP}@1793446462.881862945?scheduled`,
    );
    expect(urls).toEqual([
      `https://m/api/v1/transactions/${toMirrorTxId(`${OP}@1793446462.881862945`)}`,
    ]);
    expect(txs.map((t) => [t.nonce, t.scheduled])).toEqual([
      [0, true],
      [1, false],
    ]);
    const verdict = checkSettlement(txs, {
      payer: OP,
      payTo: SHOP,
      asset: USDC,
      amount: 30000n,
      feePayer: OP,
    });
    expect(verdict).toEqual({ ok: true, fee: 7n });
  });

  it("waits while the schedule hasn't run yet (only the ScheduleCreate is there)", async () => {
    const fetchImpl = (async () =>
      Response.json({ transactions: [family.transactions[0]] })) as unknown as typeof fetch;
    const txs = await mirrorRecordFetcher("https://m", { fetchImpl, attempts: 2, delayMs: 1 })(
      `${OP}@1.2?scheduled`,
    );
    expect(txs).toEqual([]);
  });
});
