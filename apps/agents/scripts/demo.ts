// End-to-end: "Plan a Goa weekend" → orchestrator hires a flights agent and a hotels agent it
// found on Arkiv, pays each through MandateRegistry over x402, they book in sandbox, and Claude
// explains every spend. Needs ANTHROPIC_API_KEY, DUFFEL_ACCESS_TOKEN, LITEAPI_KEY in .env.
// Run: pnpm --filter @eth/agents demo ["your request"]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARKIV_EXPLORER, arkivReader, arkivWriter } from "@eth/arkiv";
import { loadConfig, NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, tokenIdToEvmAddress } from "@eth/mandates";
import { DuffelClient, LiteApiClient } from "@eth/travel";
import { createPayingFetch, HttpFacilitator, MirrorResolver } from "@eth/x402";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadIdentities } from "../src/identities";
import { runTrip } from "../src/orchestrator/run";
import { flightsAgent } from "../src/specialists/flights";
import { hotelsAgent } from "../src/specialists/hotels";
import { createSpecialist } from "../src/specialists/server";

for (const k of ["ANTHROPIC_API_KEY", "DUFFEL_ACCESS_TOKEN", "LITEAPI_KEY"]) {
  if (!process.env[k]) throw new Error(`${k} is empty in .env`);
}
const request =
  process.argv[2] ??
  "Plan a weekend in Goa for 2 of us, flying from Mumbai next Friday and back on Sunday. Budget ₹40,000.";
const config = loadConfig();
const net = NETWORKS.testnet;
const ids = loadIdentities();
const operatorKey = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const tx = (id: string) => `${net.hashscanUrl}/transaction/${id}`;
const log = (line: string) => console.log(`  · ${line}`);

// ── Facilitator (separate process, as in production) ─────────────────
const facilitatorDir = fileURLToPath(new URL("../../facilitator", import.meta.url));
const facilitator = spawn("npx", ["tsx", "--env-file=../../.env", "src/index.ts"], {
  cwd: facilitatorDir,
  stdio: "ignore",
});
for (let i = 0; i < 40; i++) {
  const ok = await fetch("http://localhost:8402/health")
    .then((r) => r.ok)
    .catch(() => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 500));
}
const facilitatorClient = new HttpFacilitator("http://localhost:8402");

// ── Specialist agents ────────────────────────────────────────────────
const ctx = (identity: typeof ids.flights, port: number) => ({
  identity,
  baseUrl: `http://localhost:${port}`,
  facilitator: facilitatorClient,
  usdcTokenId: net.usdcTokenId,
  executorId: DEPLOYMENTS.testnet.mandateRegistryId,
});
const flights = createSpecialist(
  flightsAgent(new DuffelClient(process.env.DUFFEL_ACCESS_TOKEN as string)),
  ctx(ids.flights, 8411),
);
const hotels = createSpecialist(
  hotelsAgent(new LiteApiClient(process.env.LITEAPI_KEY as string)),
  ctx(ids.hotels, 8412),
);
const servers = [
  serve({ fetch: flights.app.fetch, port: 8411 }),
  serve({ fetch: hotels.app.fetch, port: 8412 }),
];
console.log(
  "1. agents online — SkyHop (flights) :8411, StayWise (hotels) :8412, facilitator :8402",
);
for (const [name, s] of [
  ["SkyHop", flights],
  ["StayWise", hotels],
] as const) {
  const r = await s.publish();
  console.log(
    `   ${name} ${r.alreadyListed ? "already listed on Arkiv" : `listed on Arkiv ${ARKIV_EXPLORER.tx(r.txHash)}`}`,
  );
}

// ── Mandate: the human gives the orchestrator a budget ───────────────
const owner = privateKeyToAccount(operatorKey);
const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
const usdc = tokenIdToEvmAddress(net.usdcTokenId);
if ((await mc.allowance(usdc, owner.address)) < 1_000_000n)
  await mc.approve(owner, usdc, 2_000_000n);
const { id: mandateId, receipt } = await mc.createMandate(owner, {
  agent: ids.orchestrator.evm,
  token: usdc,
  budget: 300_000n, // 0.30 USDC of agent fees
  perPaymentCap: 100_000n,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  payees: [ids.flights.evm, ids.hotels.evm],
});
console.log(
  `2. mandate #${mandateId}: orchestrator may spend 0.30 USDC on agent fees (SkyHop, StayWise only)  ${tx(receipt.transactionHash)}`,
);

// ── The orchestrator runs the trip ───────────────────────────────────
console.log(`3. request: "${request}"`);
const orchestrator = privateKeyToAccount(ids.orchestrator.key);
const run = await runTrip(request, {
  arkiv: arkivReader(),
  buyerWriter: arkivWriter(ids.orchestrator.key),
  platformWriter: arkivWriter(operatorKey),
  payingFetch: createPayingFetch({
    agent: orchestrator,
    mandateId,
    payer: config.operatorId,
    executor: DEPLOYMENTS.testnet.mandateRegistryId,
    executorEvm: DEPLOYMENTS.testnet.mandateRegistry,
    chainId: hederaTestnet.id,
    resolver: new MirrorResolver(net.mirrorUrl),
    maxAmount: 100_000n,
  }),
  evm: mc.publicClient,
  registry: DEPLOYMENTS.testnet.mandateRegistry,
  mandateId,
  payer: config.operatorId,
  log,
});

// ── Result ───────────────────────────────────────────────────────────
const e = run.explanation;
console.log(`\n4. ${e.headline}`);
for (const line of e.itinerary) console.log(`   • ${line}`);
console.log("   Spends:");
for (const s of e.spends) console.log(`   • ${s.what}: ${s.amountUsdc} USDC — ${s.why}`);
for (const h of run.hires)
  console.log(`     ${h.skill}: ${tx(h.hederaTx)}  job ${ARKIV_EXPLORER.entity(h.jobKey)}`);
for (const c of e.caveats) console.log(`   ⚠ ${c}`);
console.log(
  `   mandate #${mandateId} remaining: ${Number(await mc.remaining(mandateId)) / 1e6} USDC`,
);

for (const s of servers) s.close();
facilitator.kill();
process.exit(run.failures.length ? 1 : 0);
