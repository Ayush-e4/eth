import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import type { Facilitator } from "./facilitator-client";
import {
  HEADERS,
  type HederaCaip,
  type PaymentPayload,
  type PaymentRequirements,
  SCHEME,
  TRANSFER_EXECUTOR,
  X402_VERSION,
} from "./types";

export interface PaywallOptions {
  network: HederaCaip;
  asset: string; // HTS token id, e.g. USDC "0.0.429274"
  amount: string; // base units, e.g. "50000" = 0.05 USDC
  payTo: string; // Hedera account id that gets paid
  executors: string[]; // admitted executor contracts, e.g. MandateRegistry "0.0.11102395"
  facilitator: Facilitator;
  description?: string;
  maxTimeoutSeconds?: number;
}

/**
 * Hono middleware that puts a route behind an x402 paywall.
 * No payment → 402 + PAYMENT-REQUIRED. With payment → verify, settle, then run the route and
 * attach PAYMENT-RESPONSE. The resource is only released after settlement is proven.
 */
export function paywall(o: PaywallOptions): MiddlewareHandler {
  const requirements: PaymentRequirements = {
    scheme: SCHEME,
    network: o.network,
    asset: o.asset,
    amount: o.amount,
    payTo: o.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 120,
    extra: { assetTransferMethod: TRANSFER_EXECUTOR, executors: o.executors },
  };

  return async (c, next) => {
    const required = (error?: string, detail?: string) => {
      const body: PaymentRequired & { detail?: string } = {
        x402Version: X402_VERSION,
        ...(error ? { error } : {}),
        ...(detail ? { detail } : {}),
        resource: {
          url: c.req.url,
          description: o.description ?? "",
          mimeType: "application/json",
        },
        accepts: [requirements],
      };
      c.header(HEADERS.required, encodePaymentRequiredHeader(body));
      c.header("Cache-Control", "no-store");
      return c.json(body, 402);
    };

    const header = c.req.header(HEADERS.signature);
    if (!header) return required();

    let payment: PaymentPayload;
    try {
      payment = decodePaymentSignatureHeader(header) as PaymentPayload;
    } catch {
      return required("invalid_payment_signature_header");
    }

    const verified = await o.facilitator.verify(payment, requirements);
    if (!verified.isValid) {
      return required(verified.invalidReason ?? "verification_failed", verified.invalidMessage);
    }

    const settled = await o.facilitator.settle(payment, requirements);
    if (!settled.success) {
      return required(settled.errorReason ?? "settlement_failed", settled.errorMessage);
    }

    c.set("x402Settlement" as never, settled as never);
    await next();
    c.res.headers.set(HEADERS.response, encodePaymentResponseHeader(settled));
  };
}
