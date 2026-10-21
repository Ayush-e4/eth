import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { signStatement } from "../auth";
import { successFee } from "../specialists/priceguard";
import { checkInvoice } from "./invoices";

const stay = privateKeyToAccount(generatePrivateKey());
const impostor = privateKeyToAccount(generatePrivateKey());
const INR_PER_USDC = 94.47;
const attestation = {
  kind: "reprice" as const,
  oldBookingId: "b1",
  newBookingId: "b2",
  checkin: "2026-11-13",
  checkout: "2026-11-15",
  paidTotal: 17815,
  comparedTotal: 18884,
  newTotal: 17815,
  currency: "INR",
  cancelFee: 0,
  refund: 17815,
  saving: 1069,
  simulated: false,
  at: "2026-10-22T00:00:00Z",
};
const invoice = async (over: { signer?: typeof stay; body?: object; units?: bigint } = {}) => {
  const proof = await signStatement(over.signer ?? stay, "attestation", {
    ...attestation,
    ...over.body,
  });
  return {
    key: "0xinv",
    creator: "0xpg",
    expiresAt: 1n,
    record: {
      agent: "0xpg",
      buyer: "0xme",
      task: "t1",
      amountUnits: over.units ?? successFee(1069, INR_PER_USDC),
      note: "",
      proof: JSON.stringify(proof),
    },
  } as never;
};
const ctx = { hotelAgent: stay.address, tripBookings: ["b1"], inrPerUsdc: INR_PER_USDC };

describe("paying PriceGuard only on proof", () => {
  it("charges 20% of the saving, in USDC at today's rate", () => {
    expect(successFee(1069, INR_PER_USDC)).toBe(2_263_152n); // ₹213.8 ≈ 2.26 USDC
  });

  it("accepts a proof signed by the hotel's agent, with a real saving and the right fee", async () => {
    const r = await checkInvoice(await invoice(), ctx);
    expect(r.ok).toBe(true);
  });

  it("rejects a proof signed by anyone else, or edited after signing", async () => {
    expect(await checkInvoice(await invoice({ signer: impostor }), ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not signed by the agent"),
    });
    const tampered = (await invoice()) as unknown as { record: { proof: string } };
    const p = JSON.parse(tampered.record.proof);
    p.body.saving = 9999;
    tampered.record.proof = JSON.stringify(p);
    expect(await checkInvoice(tampered as never, ctx)).toMatchObject({
      ok: false,
      reason: "proof signature is invalid",
    });
  });

  it("rejects proofs about other bookings, no-saving proofs and inflated fees", async () => {
    expect((await checkInvoice(await invoice({ body: { oldBookingId: "zz" } }), ctx)).ok).toBe(
      false,
    );
    expect(
      (await checkInvoice(await invoice({ body: { newTotal: 17815, saving: 0 } }), ctx)).ok,
    ).toBe(false);
    expect(await checkInvoice(await invoice({ units: 4_000_000n }), ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("20%"),
    });
    const huge = await invoice({
      body: { comparedTotal: 50000, newTotal: 17815, saving: 32185 },
      units: successFee(32185, INR_PER_USDC),
    });
    expect(await checkInvoice(huge, ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("cap"),
    });
  });

  it("won't pay for a SIMULATED saving unless a demo explicitly opts in", async () => {
    const sim = await invoice({ body: { simulated: true } });
    expect(await checkInvoice(sim, ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("SIMULATED"),
    });
    expect((await checkInvoice(sim, { ...ctx, allowSimulated: true })).ok).toBe(true);
    // …but the rebook itself is authentic, so the trip can still follow it
    expect(await checkInvoice(sim, ctx)).toMatchObject({
      proof: { newBookingId: "b2", simulated: true },
    });
  });
});
