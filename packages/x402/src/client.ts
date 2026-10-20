import {
  encodeX402Authorization,
  mandateDomain,
  randomNonce,
  signPaymentAuth,
} from "@eth/mandates";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { LocalAccount } from "viem";
import type { MirrorResolver } from "./resolve";
import {
  ExecutorExtraSchema,
  HEADERS,
  type PaymentPayload,
  type PaymentRequirements,
  SCHEME,
  X402_VERSION,
} from "./types";

export interface MandateWallet {
  agent: LocalAccount; // the agent's signing key
  mandateId: bigint;
  payer: string; // mandate owner's Hedera account (funds are debited from here)
  executor: string; // MandateRegistry Hedera contract id
  executorEvm: `0x${string}`;
  chainId: number;
  resolver: MirrorResolver;
  /** Client-side guard on top of the onchain mandate: never sign more than this per call. */
  maxAmount?: bigint;
}

export interface PaidResponse {
  response: Response;
  paid?: { requirements: PaymentRequirements; settlement: SettleResponse };
}

/**
 * fetch() for agents: if a server answers 402, pick a transferExecutor offer our mandate can
 * pay, sign a single-use PaymentAuth, and retry with PAYMENT-SIGNATURE. No human involved —
 * the onchain mandate is what limits the agent.
 */
export function createPayingFetch(w: MandateWallet, fetchImpl: typeof fetch = fetch) {
  return async (url: string, init: RequestInit = {}): Promise<PaidResponse> => {
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return { response: first };

    const header = first.headers.get(HEADERS.required);
    if (!header) throw new Error("402 without a PAYMENT-REQUIRED header");
    const required = decodePaymentRequiredHeader(header) as PaymentRequired;

    const offer = required.accepts.find((r) => {
      const extra = ExecutorExtraSchema.safeParse(r.extra);
      return r.scheme === SCHEME && extra.success && extra.data.executors.includes(w.executor);
    });
    if (!offer) throw new Error("No payment option our mandate can pay");
    const amount = BigInt(offer.amount);
    if (w.maxAmount !== undefined && amount > w.maxAmount) {
      throw new Error(`Price ${amount} exceeds this agent's per-call limit ${w.maxAmount}`);
    }

    // Sign exactly what the facilitator will execute: payTo resolved the same way it does.
    const payTo = await w.resolver.accountToEvm(offer.payTo);
    const auth = {
      mandateId: w.mandateId,
      payTo,
      amount,
      nonce: randomNonce(),
      validBefore: BigInt(Math.floor(Date.now() / 1000) + Math.min(offer.maxTimeoutSeconds, 120)),
    };
    const signature = await signPaymentAuth(w.agent, mandateDomain(w.chainId, w.executorEvm), auth);

    const payment: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: required.resource,
      accepted: offer,
      payload: {
        payer: w.payer,
        executor: w.executor,
        authorization: encodeX402Authorization(auth, signature),
      },
    };
    const headers = new Headers(init.headers);
    headers.set(HEADERS.signature, encodePaymentSignatureHeader(payment));
    const response = await fetchImpl(url, { ...init, headers });

    const settlementHeader = response.headers.get(HEADERS.response);
    if (response.ok && settlementHeader) {
      const settlement = decodePaymentResponseHeader(settlementHeader) as SettleResponse;
      return { response, paid: { requirements: offer, settlement } };
    }
    return { response };
  };
}
