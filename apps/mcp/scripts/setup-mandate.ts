// One-time setup for the MCP server: its own key, a spending limit (mandate) on Hedera that only
// that key can spend, and the snippet to add it to Claude Desktop / Claude Code.
// Run: pnpm --filter @eth/mcp setup-mandate [budgetUsdc=1] [days=7]
// The agents must be running (pnpm --filter @eth/agents serve): only reachable agents become payees.
import { fileURLToPath } from "node:url";
import { arkivReader, arkivWriter } from "@eth/arkiv";
import { NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, tokenIdToEvmAddress } from "@eth/mandates";
import { type Hex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CONFIG_PATH, readSavedConfig, saveConfig } from "../src/config";
import { listedAgents } from "../src/deps";

const PER_PAYMENT_CAP = 100_000n; // 0.10 USDC
const [budgetArg = "1", daysArg = "7"] = process.argv.slice(2);
const budget = BigInt(Math.round(Number(budgetArg) * 1e6));
const days = Number(daysArg);
if (!(budget > 0n && budget <= 5_000_000n) || !(days > 0 && days <= 30))
  throw new Error("budget must be 0–5 USDC and days 1–30");

const raw = process.env.HEDERA_PRIVATE_KEY ?? "";
const payer = process.env.HEDERA_ACCOUNT_ID ?? "";
if (!raw || !payer) throw new Error("HEDERA_PRIVATE_KEY and HEDERA_ACCOUNT_ID must be set in .env");
const owner = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);

// Keep the MCP server's key if it already has one, so its Arkiv history stays together.
const agentKey = readSavedConfig()?.agentKey ?? generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
console.log(`MCP server key: ${agent.address} (stays in ${CONFIG_PATH})`);

// Payees: listed agents whose live service answers as that same agent (skips stale or fake listings).
const payees: { name: string; agent: `0x${string}` }[] = [];
for (const a of await listedAgents()) {
  const profile = (await fetch(a.endpoint, { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json())
    .catch(() => null)) as { agent?: string } | null;
  if (profile?.agent?.toLowerCase() !== a.agent.toLowerCase()) continue;
  if (!payees.some((p) => p.agent.toLowerCase() === a.agent.toLowerCase()))
    payees.push({ name: a.name, agent: a.agent as `0x${string}` });
}
if (!payees.length)
  throw new Error("No reachable agents. Start them: pnpm --filter @eth/agents serve");
console.log(`Payees: ${payees.map((p) => p.name).join(", ")}`);

const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
const usdc = tokenIdToEvmAddress(NETWORKS.testnet.usdcTokenId);
const allowance = await mc.allowance(usdc, owner.address);
if (allowance < budget) await mc.approve(owner, usdc, allowance + budget);
const expiresAt = Math.floor(Date.now() / 1000) + days * 86_400;
const { id, receipt } = await mc.createMandate(owner, {
  agent: agent.address,
  token: usdc,
  budget,
  perPaymentCap: PER_PAYMENT_CAP,
  expiresAt: BigInt(expiresAt),
  payees: payees.map((p) => p.agent),
});
console.log(
  `Mandate #${id}: up to ${budgetArg} USDC for ${days} days, ≤0.10 per payment  ${NETWORKS.testnet.hashscanUrl}/transaction/${receipt.transactionHash}`,
);

// The key writes job records on Arkiv as the buyer, which costs a little test ETH there.
if ((await arkivReader().getBalance({ address: agent.address })) < parseEther("0.01")) {
  await arkivWriter(`0x${raw.replace(/^0x/, "")}` as Hex).sendTransaction({
    to: agent.address,
    value: parseEther("0.05"),
  });
  console.log("Sent 0.05 test GLM (Arkiv Rabdi) to the MCP key for Arkiv records");
}

saveConfig({
  agentKey,
  mandateId: id.toString(),
  payer,
  perPaymentCapUnits: PER_PAYMENT_CAP.toString(),
  expiresAt,
  registry: DEPLOYMENTS.testnet.mandateRegistry,
});

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
console.log(`
Add it to Claude Code:
  claude mcp add agentnet -- ${tsx} ${entry}

Or to Claude Desktop (Settings → Developer → Edit config):
${JSON.stringify({ mcpServers: { agentnet: { command: tsx, args: [entry] } } }, null, 2)}
`);
