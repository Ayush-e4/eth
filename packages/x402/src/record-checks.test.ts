import { describe, expect, it } from "vitest";
import { checkSettlement, type MirrorTx, MirrorTxSchema } from "./record-checks";

const USDC = "0.0.429274";
const OWNER = "0.0.11045937";
const SHOP = "0.0.11102187";
const FACIL = "0.0.11045937"; // same account can be fee payer and payer in tests below where noted
const FEE_PAYER = "0.0.9000";

const expectation = {
  payer: OWNER,
  payTo: SHOP,
  asset: USDC,
  amount: 300_000n,
  feePayer: FEE_PAYER,
};

/** Shaped like the real mirror records of our mandate payment on testnet. */
function records(overrides: Partial<{ parent: Partial<MirrorTx>; child: Partial<MirrorTx> }> = {}) {
  return [
    MirrorTxSchema.parse({
      transaction_id: "0.0.9000-1-2",
      result: "SUCCESS",
      charged_tx_fee: 10_179_090,
      nonce: 0,
      transfers: [
        { account: "0.0.802", amount: 10_179_090 },
        { account: FEE_PAYER, amount: -10_179_090 },
      ],
      ...overrides.parent,
    }),
    MirrorTxSchema.parse({
      transaction_id: "0.0.9000-1-2",
      result: "SUCCESS",
      nonce: 1,
      token_transfers: [
        { token_id: USDC, account: OWNER, amount: -300_000 },
        { token_id: USDC, account: SHOP, amount: 300_000 },
      ],
      ...overrides.child,
    }),
  ];
}

describe("checkSettlement", () => {
  it("accepts a clean payment (parent fee + child token transfer)", () => {
    expect(checkSettlement(records(), expectation)).toEqual({ ok: true, fee: 10_179_090n });
  });

  it("is pending when there are no records", () => {
    expect(checkSettlement([], expectation)).toMatchObject({
      ok: false,
      reason: "settlement_pending",
    });
  });

  it("rejects a failed child record", () => {
    const r = checkSettlement(
      records({ child: { result: "INSUFFICIENT_TOKEN_BALANCE" } }),
      expectation,
    );
    expect(r).toMatchObject({ ok: false, reason: "settlement_status_not_success" });
  });

  it("rejects the wrong amount reaching payTo", () => {
    const child = {
      token_transfers: [
        { token_id: USDC, account: OWNER, amount: -200_000 },
        { token_id: USDC, account: SHOP, amount: 200_000 },
      ],
    };
    expect(checkSettlement(records({ child }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_payee_credit_mismatch",
    });
  });

  it("rejects a third account losing tokens", () => {
    const child = {
      token_transfers: [
        { token_id: USDC, account: "0.0.666", amount: -300_000 },
        { token_id: USDC, account: SHOP, amount: 300_000 },
      ],
    };
    expect(checkSettlement(records({ child }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_unexpected_debit",
    });
  });

  it("rejects a side payment to someone else", () => {
    const child = {
      token_transfers: [
        { token_id: USDC, account: OWNER, amount: -400_000 },
        { token_id: USDC, account: SHOP, amount: 300_000 },
        { token_id: USDC, account: "0.0.777", amount: 100_000 },
      ],
    };
    expect(checkSettlement(records({ child }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_unexpected_transfer",
    });
  });

  it("rejects movement of a different token", () => {
    const child = {
      token_transfers: [
        ...(records()[1]?.token_transfers ?? []),
        { token_id: "0.0.1234", account: OWNER, amount: -1 },
        { token_id: "0.0.1234", account: SHOP, amount: 1 },
      ],
    };
    expect(checkSettlement(records({ child }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_unexpected_transfer",
    });
  });

  it("rejects any NFT movement", () => {
    expect(checkSettlement(records({ child: { nft_transfers: [{}] } }), expectation)).toMatchObject(
      {
        ok: false,
        reason: "settlement_unexpected_transfer",
      },
    );
  });

  it("rejects HBAR leaving anyone other than the fee payer", () => {
    const parent = {
      transfers: [
        { account: "0.0.802", amount: 10_179_090 + 5 },
        { account: FEE_PAYER, amount: -10_179_090 },
        { account: OWNER, amount: -5 },
      ],
    };
    expect(checkSettlement(records({ parent }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_unexpected_debit",
    });
  });

  it("rejects a fee payer debit that differs from the record fee", () => {
    const parent = {
      transfers: [
        { account: "0.0.802", amount: 20_000_000 },
        { account: FEE_PAYER, amount: -20_000_000 },
      ],
    };
    expect(checkSettlement(records({ parent }), expectation)).toMatchObject({
      ok: false,
      reason: "settlement_fee_payer_debit_mismatch",
    });
  });

  it("works when the payer is also the fee payer's account for tokens (separate lists)", () => {
    const e = { ...expectation, feePayer: FACIL };
    const parent = {
      transfers: [
        { account: "0.0.802", amount: 10_179_090 },
        { account: FACIL, amount: -10_179_090 },
      ],
    };
    expect(checkSettlement(records({ parent }), e)).toEqual({ ok: true, fee: 10_179_090n });
  });
});
