// What a running agent needs for money: its refunds, its job database, and a way to ask the
// chain whether a payment happened. Kept apart from runtime.ts, which wires up the market.
import { fileURLToPath } from "node:url";
import { createClient, executeContract, NETWORKS, transferToken } from "@eth/hedera";
import {
  DEPLOYMENTS,
  EscrowClient,
  hederaTestnet,
  MandateClient,
  mandateRegistryAbi,
  paymentState,
  revertName,
} from "@eth/mandates";
import { encodeFunctionData, type Hex } from "viem";
import type { SpecialistIdentity } from "../src/identities";
import type { EscrowMoves } from "../src/specialists/escrow";

const net = NETWORKS.testnet;

const ownClient = (identity: SpecialistIdentity) =>
  createClient({
    network: "testnet",
    operatorId: identity.hederaAccount,
    operatorKey: identity.key.replace(/^0x/, ""),
  });

/** Refunds come from the agent's own Hedera account, signed with its own key. */
export function refunder(identity: SpecialistIdentity) {
  const client = ownClient(identity);
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

/**
 * Pay on delivery (on unless ESCROW=off): agents take their /work fee into MandateRegistry and
 * move it from their own Hedera account, so the contract sees the address the buyer paid. The
 * buyer has `deliverSeconds` to get its result and `reviewSeconds` to release it before we claim.
 */
export const ESCROW_TERMS = { deliverSeconds: 900, reviewSeconds: 900 };
const ESCROW_GAS = { markDelivered: 150_000, refund: 300_000, claim: 300_000, release: 300_000 };

export function escrowMoves(
  identity: SpecialistIdentity,
  env: Record<string, string | undefined> = process.env,
): EscrowMoves | undefined {
  if (env.ESCROW === "off") return undefined;
  const client = ownClient(identity);
  const reader = new EscrowClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
  const call = async (functionName: keyof typeof ESCROW_GAS, args: readonly unknown[]) => {
    // Simulated first, so a move that isn't allowed fails with the contract's own error name.
    await reader.publicClient
      .simulateContract({
        account: identity.evm,
        address: DEPLOYMENTS.testnet.mandateRegistry,
        abi: mandateRegistryAbi,
        functionName,
        args,
      } as never)
      .catch((err: unknown) => {
        throw new Error(`${functionName}: ${revertName(err)}`);
      });
    const data = encodeFunctionData({ abi: mandateRegistryAbi, functionName, args } as never);
    return executeContract(client, {
      contractId: DEPLOYMENTS.testnet.mandateRegistryId,
      data,
      gas: ESCROW_GAS[functionName],
    });
  };
  return {
    terms: ESCROW_TERMS,
    deliver: (id: Hex, hash: Hex) => call("markDelivered", [id, hash]),
    refund: (id: Hex) => call("refund", [id]),
    claim: (id: Hex) => call("claim", [id]),
    read: (id: Hex) => reader.get(id),
  };
}

/** For an agent that hires others (TripMint): pay the held fee out once it has the result. */
export const escrowReleaser = (identity: SpecialistIdentity) => {
  const client = ownClient(identity);
  return (id: Hex) =>
    executeContract(client, {
      contractId: DEPLOYMENTS.testnet.mandateRegistryId,
      data: encodeFunctionData({ abi: mandateRegistryAbi, functionName: "release", args: [id] }),
      gas: ESCROW_GAS.release,
    });
};
