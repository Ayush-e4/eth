import { decodeX402EscrowAuthorization } from "@eth/mandates";
import type { Hex } from "viem";
import {
  ERR,
  ExecutorExtraSchema,
  type ExecutorPayload,
  ExecutorPayloadSchema,
  type HederaCaip,
  type PaymentPayload,
  type PaymentRequirements,
  SCHEME,
  X402_VERSION,
} from "../types";

export type Invalid = { isValid: false; invalidReason: string; invalidMessage: string };
export type Validated = { isValid: true; payload: ExecutorPayload };

const invalid = (invalidReason: string, invalidMessage: string): Invalid => ({
  isValid: false,
  invalidReason,
  invalidMessage,
});

/**
 * Spec Phase 3, steps 1–3: shape, method support, executor admission.
 * Pure — no network calls — so it is cheap and fully unit-testable.
 */
export function validateExecutorPayment(
  p: PaymentPayload,
  req: PaymentRequirements,
  ctx: { network: HederaCaip; admittedExecutors: readonly string[] },
): Invalid | Validated {
  if (p.x402Version !== X402_VERSION)
    return invalid(ERR.invalidVersion, `x402Version ${p.x402Version}`);
  if (req.scheme !== SCHEME || p.accepted?.scheme !== SCHEME) {
    return invalid(ERR.invalidScheme, `scheme must be "${SCHEME}"`);
  }
  if (req.network !== ctx.network || p.accepted.network !== ctx.network) {
    return invalid(ERR.invalidNetwork, `network must be ${ctx.network}`);
  }
  if (!/^0\.0\.\d+$/.test(req.asset) || req.asset === "0.0.0") {
    return invalid(
      ERR.invalidRequirements,
      "asset must be an HTS token id (HBAR not supported here)",
    );
  }
  if (!/^\d+$/.test(req.amount) || BigInt(req.amount) <= 0n) {
    return invalid(ERR.invalidRequirements, "amount must be a positive integer string");
  }
  if (!/^0\.0\.\d+$/.test(req.payTo))
    return invalid(ERR.invalidRequirements, "payTo must be 0.0.x");

  // The client must have accepted exactly what the server asked for.
  const a = p.accepted;
  if (a.amount !== req.amount || a.asset !== req.asset || a.payTo !== req.payTo) {
    return invalid(ERR.invalidPayload, "accepted terms differ from the payment requirements");
  }

  const extra = ExecutorExtraSchema.safeParse(a.extra);
  if (!extra.success) {
    const method = (a.extra as { assetTransferMethod?: unknown } | undefined)?.assetTransferMethod;
    return invalid(
      ERR.unsupportedMethod,
      `assetTransferMethod ${String(method ?? "cryptoTransfer")}`,
    );
  }

  const parsed = ExecutorPayloadSchema.safeParse(p.payload);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    const reason =
      field === "payer"
        ? ERR.payloadPayer
        : field === "executor"
          ? ERR.payloadExecutor
          : field === "authorization"
            ? ERR.payloadAuthorization
            : ERR.invalidPayload;
    return invalid(reason, parsed.error.issues[0]?.message ?? "invalid payload");
  }

  const { executor } = parsed.data;
  if (!ctx.admittedExecutors.includes(executor) || !extra.data.executors.includes(executor)) {
    return invalid(ERR.executorNotAdmitted, `executor ${executor} is not admitted`);
  }
  return { isValid: true, payload: parsed.data };
}

/**
 * Pay on delivery, when the payee asks for it: the authorization must be the escrow form, signed
 * on the payee's terms (no longer a review window, at least `deliverSeconds` to deliver). The
 * terms come from the payee's requirements, never from what the client sent.
 */
export function escrowTerms(
  req: PaymentRequirements,
  authorization: Hex,
): Invalid | { isValid: true; escrow: boolean } {
  const terms = ExecutorExtraSchema.safeParse(req.extra).data?.escrow;
  if (!terms) return { isValid: true, escrow: false };
  let a: ReturnType<typeof decodeX402EscrowAuthorization>;
  try {
    a = decodeX402EscrowAuthorization(authorization);
  } catch {
    return invalid(ERR.payloadAuthorization, "not an escrow (pay on delivery) authorization");
  }
  if (a.reviewSeconds > terms.reviewSeconds)
    return invalid(ERR.escrowTerms, `review window ${a.reviewSeconds}s > ${terms.reviewSeconds}s`);
  if (a.deliverBy < a.validBefore + BigInt(terms.deliverSeconds))
    return invalid(ERR.escrowTerms, `deliver-by leaves under ${terms.deliverSeconds}s to deliver`);
  return { isValid: true, escrow: true };
}
