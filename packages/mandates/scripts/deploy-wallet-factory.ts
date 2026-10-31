// Deploys the PasskeyWalletFactory (from `forge build` output) and prints the .env line that
// turns on Face ID wallets. Run: pnpm --filter @eth/mandates deploy-wallet-factory
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, NETWORKS } from "@eth/hedera";
import { createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet, passkeyWalletFactoryAbi } from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../contracts/out/PasskeyWalletFactory.sol/PasskeyWalletFactory.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { bytecode: { object: Hex } };

const wallet = createWalletClient({
  account: privateKeyToAccount(key),
  chain: hederaTestnet,
  transport: http(),
});
const reader = createPublicClient({ chain: hederaTestnet, transport: http() });
const hash = await wallet.deployContract({
  abi: passkeyWalletFactoryAbi,
  bytecode: artifact.bytecode.object,
  gas: 4_000_000n,
});
const receipt = await reader.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`failed: ${hash}`);
console.log(`deployed ${receipt.contractAddress}  ${net.hashscanUrl}/transaction/${hash}`);
console.log(`\nAdd to .env:\nPASSKEY_WALLET_FACTORY=${receipt.contractAddress}`);
