import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, type Hex, http, type LocalAccount } from "viem";
import { mandateRegistryAbi } from "./abi";
import { hederaTestnet } from "./chain";

/**
 * Deploys a fresh MandateRegistry from Foundry's build output (`forge build` in
 * packages/contracts). Only needed after a testnet reset wiped the old one. The contract has no
 * owner and no admin: once deployed, nobody can change it. Returns its EVM address and Hedera id.
 */
export async function deployRegistry(
  deployer: LocalAccount,
  artifactPath: string,
  mirrorUrl: string,
): Promise<{ address: `0x${string}`; contractId: string; txHash: Hex }> {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: deployer, chain: hederaTestnet, transport: http() });
  const reader = createPublicClient({ chain: hederaTestnet, transport: http() });
  const txHash = await wallet.deployContract({
    abi: mandateRegistryAbi,
    bytecode: artifact.bytecode.object,
    gas: 4_000_000n,
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error(`deploy failed: ${txHash}`);
  const address = receipt.contractAddress;
  // The mirror needs a moment to index the new contract; its Hedera id comes from there.
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${mirrorUrl}/api/v1/contracts/${address}`).catch(() => null);
    if (res?.ok) {
      const { contract_id } = (await res.json()) as { contract_id: string };
      return { address, contractId: contract_id, txHash };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`deployed at ${address}, but the mirror hasn't shown its Hedera id yet`);
}
