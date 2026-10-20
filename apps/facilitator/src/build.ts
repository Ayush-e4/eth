import { createClient, type HederaConfig, NETWORKS, submitMessage } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet } from "@eth/mandates";
import { ExecutorFacilitator, MirrorResolver, mirrorRecordFetcher } from "@eth/x402";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface FacilitatorEnv {
  hedera: HederaConfig;
  /** Optional HCS topic for the public spend log. */
  spendLogTopicId?: string;
  gas?: bigint;
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
    onSettled: env.spendLogTopicId
      ? async (s) => {
          const [mandateId] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
            s.authorization,
          );
          await submitMessage(hedera, {
            topicId: env.spendLogTopicId as string,
            submitKey: env.hedera.operatorKey,
            message: {
              kind: "x402.settled",
              mandateId: mandateId.toString(),
              payer: s.payer,
              payTo: s.payTo,
              asset: s.asset,
              amount: s.amount,
              executor: s.executor,
              transaction: s.transaction,
              at: new Date().toISOString(),
            },
          }).catch((err) => console.error("spend-log write failed:", err));
        }
      : undefined,
  });
}
