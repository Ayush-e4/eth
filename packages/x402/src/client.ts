import {
  encodeX402Authorization,
  encodeX402EscrowAuthorization,
  escrowIdOf,
  mandateDomain,
  randomNonce,
  signEscrowAuth,
  signPaymentAuth,
} from "@eth/mandates";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { Hex, LocalAccount } from "viem";
import type { MirrorResolver } from "./resolve";
import {
  ExecutorExtraSchema,
  HEADERS,
  type PaymentPayload,
  type PaymentRequirements,
  paymentKey,
  SCHEME,
  UNDO_EXTENSION,
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
  /** Ask the facilitator to settle after this many seconds, cancellable until then. */
  undoSeconds?: number;
  /** Told the payment's key as soon as it's signed (to find and cancel its schedule). */
  onSigned?: (key: string) => void;
}

export interface PaidResponse {
  response: Response;
  paid?: {
    requirements: PaymentRequirements;
    settlement: SettleResponse;
    /** Paid on delivery: the escrow holding the fee until the job is delivered and released. */
    escrowId?: Hex;
  };
}

/**
 * fetch() for agents: if a server answers 402, pick a transferExecutor offer our mandate can
 * pay, sign a single-use PaymentAuth (an EscrowAuth when it's paid on delivery), and retry with
 * PAYMENT-SIGNATURE. No human involved —
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
    const escrow = ExecutorExtraSchema.parse(offer.extra).escrow;
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
      // With an undo window the payment runs later: keep the authorization valid until then.
      validBefore: BigInt(
        Math.floor(Date.now() / 1000) +
          Math.min(offer.maxTimeoutSeconds, 120) +
          (w.undoSeconds ?? 0),
      ),
    };
    const domain = mandateDomain(w.chainId, w.executorEvm);
    // Pay on delivery: the payee gets `deliverSeconds` from the latest the payment can run.
    const authorization = escrow
      ? await (async () => {
          const e = {
            ...auth,
            deliverBy: auth.validBefore + BigInt(escrow.deliverSeconds),
            reviewSeconds: escrow.reviewSeconds,
          };
          return encodeX402EscrowAuthorization(e, await signEscrowAuth(w.agent, domain, e));
        })()
      : encodeX402Authorization(auth, await signPaymentAuth(w.agent, domain, auth));

    const payment: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: required.resource,
      accepted: offer,
      payload: {
        payer: w.payer,
        executor: w.executor,
        authorization,
      },
      ...(w.undoSeconds ? { extensions: { [UNDO_EXTENSION]: { seconds: w.undoSeconds } } } : {}),
    };
    w.onSigned?.(
      paymentKey(offer.network, w.executor, w.payer, payment.payload.authorization as string),
    );
    const headers = new Headers(init.headers);
    headers.set(HEADERS.signature, encodePaymentSignatureHeader(payment));
    const response = await fetchImpl(url, { ...init, headers });

    const settlementHeader = response.headers.get(HEADERS.response);
    if (response.ok && settlementHeader) {
      const settlement = decodePaymentResponseHeader(settlementHeader) as SettleResponse;
      return {
        response,
        paid: {
          requirements: offer,
          settlement,
          ...(escrow ? { escrowId: escrowIdOf(w.mandateId, auth.nonce) } : {}),
        },
      };
    }
    return { response };
  };
}
