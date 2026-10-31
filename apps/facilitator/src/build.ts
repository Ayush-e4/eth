import { createClient, type HederaConfig, NETWORKS, submitMessage } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet } from "@eth/mandates";
import {
  ExecutorFacilitator,
  MirrorResolver,
  mirrorRecordFetcher,
  paymentScheduler,
} from "@eth/x402";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface FacilitatorEnv {
  hedera: HederaConfig;
  /** Optional HCS topic for the public spend log. */
  spendLogTopicId?: string;
  gas?: bigint;
  /** On start, delete undo-window payments a previous run left pending (see scheduler.sweep). */
  sweepOnStart?: boolean;
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
  if (env.sweepOnStart)
    void scheduler.sweep().then(async (ids) => {
      for (const scheduleId of ids) {
        console.log(`deleted schedule ${scheduleId}: left pending by the last run`);
        await log({
          kind: "x402.schedule.cancelled",
          scheduleId,
          reason: "the facilitator restarted, so nobody was waiting for this payment",
        });
      }
    });
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
      const [mandateId] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
        s.authorization,
      );
      await log({
        kind: "x402.settled",
        mandateId: mandateId.toString(),
        payer: s.payer,
        payTo: s.payTo,
        asset: s.asset,
        amount: s.amount,
        executor: s.executor,
        transaction: s.transaction,
      });
    },
  });
}
