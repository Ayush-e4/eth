import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { keccak256, toHex } from "viem";
import { z } from "zod";

export type { PaymentPayload, PaymentRequirements };

export const X402_VERSION = 2;
export const SCHEME = "exact";
export const TRANSFER_EXECUTOR = "transferExecutor";

/** CAIP-2 network ids used by x402 for Hedera. */
export type HederaCaip = "hedera:testnet" | "hedera:mainnet";

/** HTTP headers defined by x402 v2 (values are base64 JSON). */
export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

const hederaId = z.string().regex(/^0\.0\.\d+$/);

/**
 * Pay on delivery: the fee waits in MandateRegistry (not with the payee) until the job is done.
 * The payee has `deliverSeconds` after the payment to mark it delivered; then the buyer releases
 * it, or after `reviewSeconds` the payee may claim it. Not delivered in time → back to the payer.
 */
export const EscrowTermsSchema = z.object({
  deliverSeconds: z
    .number()
    .int()
    .min(30)
    .max(7 * 86_400),
  reviewSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400),
});
export type EscrowTerms = z.infer<typeof EscrowTermsSchema>;

/** `accepted.extra` for the transferExecutor method; with `escrow`, it's paid on delivery. */
export const ExecutorExtraSchema = z.object({
  assetTransferMethod: z.literal(TRANSFER_EXECUTOR),
  executors: z.array(hederaId).min(1),
  escrow: EscrowTermsSchema.optional(),
});

/** `payload` for the transferExecutor method (spec Phase 2). */
export const ExecutorPayloadSchema = z.object({
  payer: hederaId,
  executor: hederaId,
  authorization: z.string().regex(/^0x[0-9a-fA-F]*$/),
});

export type ExecutorPayload = z.infer<typeof ExecutorPayloadSchema>;

/** Stable error tokens from the spec, plus the core v2 ones we use. */
export const ERR = {
  invalidPayload: "invalid_payload",
  invalidRequirements: "invalid_payment_requirements",
  invalidScheme: "invalid_scheme",
  invalidNetwork: "invalid_network",
  invalidVersion: "invalid_x402_version",
  unsupportedMethod: "invalid_exact_hedera_unsupported_asset_transfer_method",
  executorNotAdmitted: "invalid_exact_hedera_executor_not_admitted",
  payloadPayer: "invalid_exact_hedera_payload_payer",
  payloadExecutor: "invalid_exact_hedera_payload_executor",
  payloadAuthorization: "invalid_exact_hedera_payload_authorization",
  escrowTerms: "invalid_exact_hedera_escrow_terms",
  customFeeAsset: "invalid_exact_hedera_custom_fee_asset",
  addressResolution: "address_resolution_failed",
  simulationReverted: "simulation_reverted",
  duplicateInFlight: "duplicate_payment_in_flight",
  statusNotSuccess: "settlement_status_not_success",
  payeeCreditMismatch: "settlement_payee_credit_mismatch",
  payerDebitMismatch: "settlement_payer_debit_mismatch",
  feePayerDebitMismatch: "settlement_fee_payer_debit_mismatch",
  unexpectedDebit: "settlement_unexpected_debit",
  unexpectedTransfer: "settlement_unexpected_transfer",
  settlementPending: "settlement_pending",
  unexpectedSettle: "unexpected_settle_error",
  paymentCancelled: "payment_cancelled_in_undo_window",
  scheduleNotRun: "scheduled_payment_not_run",
} as const;

/**
 * Our x402 extension: settle this payment after an undo window instead of now. The facilitator
 * schedules it on Hedera; the buyer's agent may cancel it until the window ends.
 */
export const UNDO_EXTENSION = "undoWindow";
export const UndoWindowSchema = z.object({ seconds: z.number().int().min(10).max(600) });

/** The message a mandate's agent signs to cancel one of its scheduled payments. */
export const cancelMessage = (scheduleId: string) => `agentnet:cancel-payment:${scheduleId}`;

/** The key a payment is tracked by; the buyer can compute it too (to find its schedule). */
export const paymentKey = (
  network: string,
  executor: string,
  payer: string,
  authorization: string,
) => keccak256(toHex(`${network}|${executor}|${payer}|${authorization}`));
