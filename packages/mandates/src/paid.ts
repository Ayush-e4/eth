import {
  type Address,
  decodeAbiParameters,
  decodeEventLog,
  encodeEventTopics,
  type Hex,
  type PublicClient,
} from "viem";
import { mandateRegistryAbi } from "./abi";

/** The x402 `authorization` bytes (see encodeX402Authorization), back into their parts. */
export function decodeX402Authorization(authorization: Hex) {
  const [mandateId, nonce, validBefore, signature] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    authorization,
  );
  return { mandateId, nonce, validBefore, signature };
}

/** The pay-on-delivery form (`executeEscrowTransfer`): also the delivery deadline and review window. */
export function decodeX402EscrowAuthorization(authorization: Hex) {
  const [mandateId, nonce, validBefore, deliverBy, reviewSeconds, signature] = decodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "uint32" },
      { type: "bytes" },
    ],
    authorization,
  );
  return { mandateId, nonce, validBefore, deliverBy, reviewSeconds, signature };
}

/** Either form starts with the mandate id. */
export const mandateIdOfAuthorization = (authorization: Hex) => BigInt(authorization.slice(0, 66));

export type PaymentState =
  | { state: "paid"; transaction?: string } // transaction: Hedera id, when the mirror has it
  | { state: "unpaid" } // can never pay now: its authorization has expired unused
  | { state: "pending" }; // not paid yet, but still could be (e.g. in its undo window)

export interface PaymentCheckDeps {
  evm: PublicClient;
  registry: Address; // MandateRegistry (EVM address)
  registryId: string; // the same contract's Hedera id, for mirror queries
  mirrorUrl: string;
  fetchImpl?: typeof fetch;
}

const SLACK_S = 30; // the network's clock and our reads can lag a little

/**
 * Did this payment happen? MandateRegistry marks each (mandate, nonce) used when it pays, so the
 * chain answers even if whoever sent the payment crashed half-way. Once `validBefore` has passed,
 * an unused nonce can never pay. Web2 analogy: asking the bank whether a cheque was cashed.
 */
export async function paymentState(
  d: PaymentCheckDeps,
  p: { mandateId: bigint; nonce: bigint; validBefore: bigint },
  now = Date.now(),
): Promise<PaymentState> {
  const used = await d.evm.readContract({
    address: d.registry,
    abi: mandateRegistryAbi,
    functionName: "nonceUsed",
    args: [p.mandateId, p.nonce],
  });
  if (used)
    return { state: "paid", transaction: await paidTransaction(d, p).catch(() => undefined) };
  return now / 1000 > Number(p.validBefore) + SLACK_S ? { state: "unpaid" } : { state: "pending" };
}

// A payment can only run while its authorization is valid: signed at most this long before
// validBefore (2 min to settle + an undo window of up to 10). The mirror needs a time range.
const VALID_FOR_S = 900;

/** The Hedera transaction that paid it, from the registry's Paid event on the mirror node. */
async function paidTransaction(
  d: PaymentCheckDeps,
  p: { mandateId: bigint; nonce: bigint; validBefore: bigint },
) {
  const fetchImpl = d.fetchImpl ?? fetch;
  const [topic0, topic1] = encodeEventTopics({
    abi: mandateRegistryAbi,
    eventName: "Paid",
    args: { mandateId: p.mandateId },
  });
  const end = Number(p.validBefore) + SLACK_S;
  const range = `timestamp=gte:${end - VALID_FOR_S - SLACK_S}&timestamp=lte:${end}`;
  const logsUrl = `${d.mirrorUrl}/api/v1/contracts/${d.registryId}/results/logs?topic0=${topic0}&topic1=${topic1}&${range}&order=desc&limit=100`;
  const { logs = [] } = (await (await fetchImpl(logsUrl)).json()) as {
    logs?: { data: Hex; topics: Hex[]; timestamp: string }[];
  };
  const log = logs.find((l) => {
    const ev = decodeEventLog({
      abi: mandateRegistryAbi,
      data: l.data,
      topics: l.topics as [Hex, ...Hex[]],
    });
    return ev.eventName === "Paid" && ev.args.nonce === p.nonce;
  });
  if (!log) return undefined;
  const txUrl = `${d.mirrorUrl}/api/v1/transactions?timestamp=${log.timestamp}`;
  const { transactions = [] } = (await (await fetchImpl(txUrl)).json()) as {
    transactions?: { transaction_id: string; scheduled?: boolean }[];
  };
  const tx = transactions.find((t) => t.scheduled) ?? transactions[0];
  if (!tx) return undefined;
  // mirror id "0.0.5-1700000000-123456789" → SDK id "0.0.5@1700000000.123456789"
  const [account, secs, nanos] = tx.transaction_id.split("-");
  return `${account}@${secs}.${nanos}${tx.scheduled ? "?scheduled" : ""}`;
}
