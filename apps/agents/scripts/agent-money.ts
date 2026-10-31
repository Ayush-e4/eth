// What a running agent needs for money: its refunds, its job database, and a way to ask the
// chain whether a payment happened. Kept apart from runtime.ts, which wires up the market.
import { fileURLToPath } from "node:url";
import { createClient, NETWORKS, transferToken } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, paymentState } from "@eth/mandates";
import type { SpecialistIdentity } from "../src/identities";

const net = NETWORKS.testnet;

/** Refunds come from the agent's own Hedera account, signed with its own key. */
export function refunder(identity: SpecialistIdentity) {
  const client = createClient({
    network: "testnet",
    operatorId: identity.hederaAccount,
    operatorKey: identity.key.replace(/^0x/, ""),
  });
  return (to: string, units: bigint, memo: string) =>
    transferToken(client, {
      tokenId: net.usdcTokenId,
      from: identity.hederaAccount,
      to,
      units,
      memo,
    });
}

/** Each agent's own database of quotes and paid jobs (gitignored; survives restarts). */
export const jobsFile = (name: string) =>
  fileURLToPath(new URL(`../.${name}.local.db`, import.meta.url));

/** Asks MandateRegistry whether a payment happened (agents recovering after a crash). */
export function paymentChecker() {
  const evm = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet).publicClient;
  const d = {
    evm,
    registry: DEPLOYMENTS.testnet.mandateRegistry,
    registryId: DEPLOYMENTS.testnet.mandateRegistryId,
    mirrorUrl: net.mirrorUrl,
  };
  return (p: { mandateId: bigint; nonce: bigint; validBefore: bigint }) => paymentState(d, p);
}
