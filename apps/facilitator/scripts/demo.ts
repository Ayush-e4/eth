// Live x402 demo on Hedera testnet — an agent pays another agent's API, no human involved.
//   1. starts our facilitator (:8402) and a paid "trip planner" API (:8403)
//   2. owner gives an agent a mandate (MandateRegistry)
//   3. agent calls the API → 402 → signs → facilitator settles via executeTransfer → 200 + receipt
//   4. owner revokes → the agent's next paid call is refused
// Run: pnpm --filter @eth/facilitator demo
import { loadConfig, Mirror, NETWORKS, unitsToUsdc } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, tokenIdToEvmAddress } from "@eth/mandates";
import { createPayingFetch, HttpFacilitator, MirrorResolver, paywall } from "@eth/x402";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app";
import { buildFacilitator } from "../src/build";

const config = loadConfig();
const net = NETWORKS.testnet;
const topic = process.env.SPEND_LOG_TOPIC_ID || undefined;
const SHOP = "0.0.11102187"; // the trip planner's account (gets paid)
const PRICE = "50000"; // 0.05 USDC
const tx = (id: string) => `${net.hashscanUrl}/transaction/${id}`;

// ── 1. Facilitator + paid API ─────────────────────────────────────────
const facilitatorServer = serve({
  fetch: createApp(buildFacilitator({ hedera: config, spendLogTopicId: topic })).fetch,
  port: 8402,
});
const api = new Hono();
api.get(
  "/plan",
  paywall({
    network: "hedera:testnet",
    asset: net.usdcTokenId,
    amount: PRICE,
    payTo: SHOP,
    executors: [DEPLOYMENTS.testnet.mandateRegistryId],
    facilitator: new HttpFacilitator("http://localhost:8402"),
    description: "Trip plan for Goa",
  }),
  (c) => c.json({ plan: ["Day 1: Baga beach", "Day 2: Old Goa churches", "Dinner at Thalassa"] }),
);
const apiServer = serve({ fetch: api.fetch, port: 8403 });
console.log("1. facilitator on :8402, trip-planner API on :8403 (0.05 USDC per call)");

// ── 2. Mandate for a fresh agent ──────────────────────────────────────
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const owner = privateKeyToAccount(key);
const agent = privateKeyToAccount(generatePrivateKey());
const usdc = tokenIdToEvmAddress(net.usdcTokenId);
const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
const resolver = new MirrorResolver(net.mirrorUrl);
const shopEvm = await resolver.accountToEvm(SHOP);

if ((await mc.allowance(usdc, owner.address)) < 1_000_000n)
  await mc.approve(owner, usdc, 2_000_000n);
const { id: mandateId, receipt } = await mc.createMandate(owner, {
  agent: agent.address,
  token: usdc,
  budget: 200_000n, // 0.20 USDC
  perPaymentCap: 100_000n,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  payees: [shopEvm],
});
console.log(
  `2. mandate #${mandateId}: agent may spend 0.20 USDC (max 0.10/call) at the trip planner`,
);
console.log(`   ${tx(receipt.transactionHash)}`);

// ── 3. The agent calls the paid API on its own ───────────────────────
const payingFetch = createPayingFetch({
  agent,
  mandateId,
  payer: config.operatorId,
  executor: DEPLOYMENTS.testnet.mandateRegistryId,
  executorEvm: DEPLOYMENTS.testnet.mandateRegistry,
  chainId: hederaTestnet.id,
  resolver,
  maxAmount: 100_000n,
});
const plain = await fetch("http://localhost:8403/plan");
console.log(`3. without payment → HTTP ${plain.status} (Payment Required)`);
const { response, paid } = await payingFetch("http://localhost:8403/plan");
console.log(`   agent paid → HTTP ${response.status}`, await response.json());
if (paid) {
  console.log(`   settled ${unitsToUsdc(BigInt(PRICE))} USDC  ${tx(paid.settlement.transaction)}`);
}
console.log(`   mandate remaining: ${unitsToUsdc(await mc.remaining(mandateId))} USDC`);

// ── 4. Kill switch ────────────────────────────────────────────────────
await mc.revoke(owner, mandateId);
const after = await payingFetch("http://localhost:8403/plan");
const body = (await after.response.json()) as { error?: string; detail?: string };
console.log(
  `4. owner revoked #${mandateId} → agent's next call: HTTP ${after.response.status} (${body.error}: ${body.detail})`,
);

if (topic) {
  await new Promise((r) => setTimeout(r, 4000));
  const [latest] = await new Mirror(net.mirrorUrl).topicMessages(topic, 1);
  console.log(`5. public spend log ${topic} latest entry #${latest?.sequence}: ${latest?.text}`);
}
facilitatorServer.close();
apiServer.close();
process.exit(0);
