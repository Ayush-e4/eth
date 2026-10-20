// Opts the operator account in to holding testnet USDC (one-time, ~$0.05 in HBAR).
// Run: pnpm --filter @eth/hedera associate-usdc
import { associateToken, createClient, hashscanTxUrl, loadConfig, Mirror, NETWORKS } from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const before = await new Mirror(net.mirrorUrl).balances(config.operatorId);

if (net.usdcTokenId in before.tokens) {
  console.log(`Already associated with USDC ${net.usdcTokenId} — nothing to do.`);
} else {
  const client = createClient(config);
  const txId = await associateToken(client, config.operatorId, config.operatorKey, net.usdcTokenId);
  client.close();
  console.log(`Associated ${config.operatorId} with USDC ${net.usdcTokenId}`);
  console.log(`receipt: ${hashscanTxUrl(config, txId)}`);
}
console.log("Next: get test USDC at https://faucet.circle.com (choose Hedera Testnet).");
