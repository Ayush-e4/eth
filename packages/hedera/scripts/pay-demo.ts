// Creates a fresh "agent" account and pays it 0.10 USDC from the operator.
// Run: pnpm --filter @eth/hedera pay-demo
import {
  createAccount,
  createClient,
  hashscanAccountUrl,
  hashscanTxUrl,
  loadConfig,
  Mirror,
  NETWORKS,
  transferToken,
  unitsToUsdc,
  usdcToUnits,
} from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const mirror = new Mirror(net.mirrorUrl);
const client = createClient(config);

const amount = usdcToUnits("0.10");
const ours = await mirror.balances(config.operatorId);
const have = ours.tokens[net.usdcTokenId] ?? 0n;
if (have < amount) {
  console.log(`Operator has ${unitsToUsdc(have)} USDC — get some at https://faucet.circle.com`);
  process.exit(1);
}

// The new account has free auto-association slots, so it can receive USDC without opting in.
const agent = await createAccount(client, { initialHbar: 1, memo: "eth demo agent" });
console.log(`agent account ${agent.accountId} (${agent.evmAddress})`);
console.log(`  created: ${hashscanTxUrl(config, agent.transactionId)}`);

const txId = await transferToken(client, {
  tokenId: net.usdcTokenId,
  from: config.operatorId,
  to: agent.accountId,
  units: amount,
  memo: "eth demo payment",
});
client.close();
console.log(`paid ${unitsToUsdc(amount)} USDC → ${agent.accountId}`);
console.log(`  receipt: ${hashscanTxUrl(config, txId)}`);

for (let attempt = 0; attempt < 10; attempt++) {
  const b = await mirror.balances(agent.accountId).catch(() => undefined);
  const got = b?.tokens[net.usdcTokenId];
  if (got !== undefined && got > 0n) {
    console.log(
      `agent balance: ${unitsToUsdc(got)} USDC  ${hashscanAccountUrl(config, agent.accountId)}`,
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("mirror node has not caught up yet — check the receipt link");
