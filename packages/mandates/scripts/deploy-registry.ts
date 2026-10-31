// Deploys a fresh MandateRegistry (from `forge build` output) and lets it hold test USDC (escrow
// needs that on Hedera). Prints the .env lines that switch the app over to it.
// Run: pnpm --filter @eth/mandates deploy-registry
import { fileURLToPath } from "node:url";
import { loadConfig, NETWORKS } from "@eth/hedera";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EscrowClient, tokenIdToEvmAddress } from "../src";
import { deployRegistry } from "../src/deploy";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const deployer = privateKeyToAccount(key);
const artifact = fileURLToPath(
  new URL("../../contracts/out/MandateRegistry.sol/MandateRegistry.json", import.meta.url),
);

const d = await deployRegistry(deployer, artifact, net.mirrorUrl);
console.log(`deployed ${d.address} (${d.contractId})  ${net.hashscanUrl}/contract/${d.contractId}`);
const assoc = await new EscrowClient(d.address).associate(
  deployer,
  tokenIdToEvmAddress(net.usdcTokenId),
);
console.log(`can hold test USDC  ${net.hashscanUrl}/transaction/${assoc.transactionHash}`);
console.log(
  `\nAdd to .env:\nMANDATE_REGISTRY_ADDRESS=${d.address}\nMANDATE_REGISTRY_ID=${d.contractId}`,
);
