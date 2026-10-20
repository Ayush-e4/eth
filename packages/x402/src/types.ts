import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
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

/** `accepted.extra` for the transferExecutor method. */
export const ExecutorExtraSchema = z.object({
  assetTransferMethod: z.literal(TRANSFER_EXECUTOR),
  executors: z.array(hederaId).min(1),
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
} as const;
