import { createClient, type HederaConfig, NETWORKS, submitMessage } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, mandateIdOfAuthorization } from "@eth/mandates";
import {
  ExecutorFacilitator,
  MirrorResolver,
  mirrorRecordFetcher,
  paymentScheduler,
} from "@eth/x402";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface FacilitatorEnv {
  hedera: HederaConfig;
  /** Optional HCS topic for the public spend log. */
  spendLogTopicId?: string;
  gas?: bigint;
  /** On start, take back undo-window payments a previous run left pending (scheduler.adopt). */
  adoptOnStart?: boolean;
}

/** Wires the x402 facilitator to Hedera testnet: our operator pays fees, MandateRegistry is admitted. */
export function buildFacilitator(env: FacilitatorEnv) {
  if (env.hedera.network !== "testnet") throw new Error("Only testnet is configured for now");
  const net = NETWORKS.testnet;
  const hedera = createClient(env.hedera);
  const key = env.hedera.operatorKey.startsWith("0x")
    ? env.hedera.operatorKey
    : `0x${env.hedera.operatorKey}`;
  const feePayerEvm = privateKeyToAccount(key as `0x${string}`).address;

  const log = (message: Record<string, unknown>) =>
    env.spendLogTopicId
      ? submitMessage(hedera, {
          topicId: env.spendLogTopicId,
          submitKey: env.hedera.operatorKey,
          message: { ...message, at: new Date().toISOString() },
        }).catch((err) => console.error("spend-log write failed:", err))
      : undefined;

  // Undo windows: our operator key can delete a pending payment schedule before it runs.
  const scheduler = paymentScheduler({
    hedera,
    adminKey: PrivateKey.fromStringECDSA(env.hedera.operatorKey),
    feePayerId: env.hedera.operatorId,
    mirrorUrl: net.mirrorUrl,
  });
  if (env.adoptOnStart)
    void scheduler
      .adopt()
      .then((ids) => ids.length && console.log(`following ${ids.length} pending payment(s)`))
      .catch((err) => console.error("adopting pending payments failed:", err));
  const cancel = scheduler.cancel;
  scheduler.cancel = async (scheduleId) => {
    const ok = await cancel(scheduleId);
    if (ok) await log({ kind: "x402.schedule.cancelled", scheduleId });
    return ok;
  };

  return new ExecutorFacilitator({
    network: "hedera:testnet",
    admittedExecutors: [DEPLOYMENTS.testnet.mandateRegistryId],
    feePayerId: env.hedera.operatorId,
    feePayerEvm,
    gas: env.gas ?? 400_000n,
    hedera,
    evm: createPublicClient({ chain: hederaTestnet, transport: http() }),
    mirror: new MirrorResolver(net.mirrorUrl),
    fetchRecords: mirrorRecordFetcher(net.mirrorUrl),
    scheduler,
    onScheduled: async (s) => {
      await log({ kind: "x402.scheduled", ...s, executesAt: new Date(s.executesAt).toISOString() });
    },
    onSettled: async (s) => {
      const mandateId = mandateIdOfAuthorization(s.authorization);
      await log({
        kind: "x402.settled",
        mandateId: mandateId.toString(),
        payer: s.payer,
        payTo: s.payTo,
        asset: s.asset,
        amount: s.amount,
        executor: s.executor,
        transaction: s.transaction,
        ...(s.escrow ? { heldInEscrow: true } : {}), // paid on delivery: the registry holds it
      });
    },
  });
}
