import type { Decoded, Invoice } from "@eth/arkiv";
import { type Signed, verifyStatement } from "../auth";
import { SUCCESS_FEE_PERCENT, successFee } from "../specialists/priceguard";
import type { RepriceAttestation } from "../specialists/staywise-reprice";

// Never pay a single success fee above 5 USDC (≈ ₹470): 20% of a ₹2,350 saving.
export const MAX_INVOICE_UNITS = 5_000_000n;

/** `proof` is set whenever the proof itself is authentic — even if the fee isn't owed. */
export type InvoiceCheck =
  | { ok: true; proof: RepriceAttestation; units: bigint }
  | { ok: false; reason: string; proof?: RepriceAttestation };

/**
 * Pay-on-proof: before paying PriceGuard, the traveller's agent checks the invoice itself —
 * the proof is signed by the agent that holds the booking, it is about a booking on this trip,
 * there really was a saving, and the fee is 20% of it at today's rate (±2%) and under a cap.
 */
export async function checkInvoice(
  inv: Decoded<Invoice>,
  ctx: { hotelAgent: string; tripBookings: string[]; inrPerUsdc: number; allowSimulated?: boolean },
): Promise<InvoiceCheck> {
  let proof: Signed<RepriceAttestation>;
  try {
    proof = JSON.parse(inv.record.proof) as Signed<RepriceAttestation>;
  } catch {
    return { ok: false, reason: "proof is not readable" };
  }
  if (proof.signer?.toLowerCase() !== ctx.hotelAgent.toLowerCase()) {
    return { ok: false, reason: "proof is not signed by the agent that holds the booking" };
  }
  if (!(await verifyStatement("attestation", proof)))
    return { ok: false, reason: "proof signature is invalid" };
  const a = proof.body;
  if (a.kind !== "reprice" || !ctx.tripBookings.includes(a.oldBookingId)) {
    return { ok: false, reason: "proof is about a booking that isn't on this trip" };
  }
  if (!(a.saving > 0) || a.newTotal >= a.comparedTotal)
    return { ok: false, proof: a, reason: "no saving" };
  // A simulated drop saved nothing real, so nothing is owed — unless a demo explicitly opts in.
  if (a.simulated && !ctx.allowSimulated) {
    return {
      ok: false,
      proof: a,
      reason: "the saving was SIMULATED (sandbox demo): no real money saved, so no fee is owed",
    };
  }
  const expected = successFee(a.saving, ctx.inrPerUsdc);
  const units = inv.record.amountUnits;
  const diff = units > expected ? units - expected : expected - units;
  if (diff * 100n > expected * 2n + 100n) {
    return {
      ok: false,
      proof: a,
      reason: `fee ${units} ≠ ${SUCCESS_FEE_PERCENT}% of saving (${expected})`,
    };
  }
  if (units > MAX_INVOICE_UNITS)
    return { ok: false, proof: a, reason: `fee above the ${MAX_INVOICE_UNITS} cap` };
  return { ok: true, proof: a, units };
}
