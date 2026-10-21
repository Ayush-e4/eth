// Shared wiring for the demo scripts: facilitator, specialist agents, a mandate, payment plumbing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARKIV_EXPLORER, arkivReader, arkivWriter } from "@eth/arkiv";
import { createClient, loadConfig, NETWORKS, transferToken } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient, tokenIdToEvmAddress } from "@eth/mandates";
import { DuffelClient, LiteApiClient, LiteFlightsClient, LiteHotelBookings } from "@eth/travel";
import { createPayingFetch, HttpFacilitator, MirrorResolver } from "@eth/x402";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadIdentities, type SpecialistIdentity } from "../src/identities";
import type { Explanation } from "../src/orchestrator/explain";
import type { HireDeps } from "../src/orchestrator/hire";
import { fetchInrRates } from "../src/orchestrator/procure";
import { airnest } from "../src/specialists/airnest";
import { createSpecialist } from "../src/specialists/server";
import { skyhop } from "../src/specialists/skyhop";
import { staywise } from "../src/specialists/staywise";
import type { BookingRecord } from "../src/specialists/staywise-manage";
import { JsonStore } from "../src/store";

export function requireEnv(keys: string[]) {
  for (const k of keys) if (!process.env[k]) throw new Error(`${k} is empty in .env`);
}

export const config = loadConfig();
export const net = NETWORKS.testnet;
export const ids = loadIdentities();
export const operatorKey = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
export const tx = (id: string) => `${net.hashscanUrl}/transaction/${id}`;
export const log = (line: string) => console.log(`  · ${line}`);
// StayWise's own records of what it booked and for whom (gitignored, survives restarts).
const STAYWISE_STORE = fileURLToPath(new URL("../.staywise.local.json", import.meta.url));

/** The x402 facilitator, as its own process (as in production). */
export async function startFacilitator() {
  const cwd = fileURLToPath(new URL("../../facilitator", import.meta.url));
  const child = spawn("npx", ["tsx", "--env-file=../../.env", "src/index.ts"], {
    cwd,
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    const ok = await fetch("http://localhost:8402/health")
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { client: new HttpFacilitator("http://localhost:8402"), stop: () => child.kill() };
}

/** Refunds come from the agent's own Hedera account, signed with its own key. */
function refunder(identity: SpecialistIdentity) {
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

type AgentName = "skyhop" | "airnest" | "staywise";
const PORTS: Record<AgentName, number> = { skyhop: 8411, staywise: 8412, airnest: 8413 };

/** Starts the chosen specialist agents and lists them on Arkiv. */
export async function startAgents(which: AgentName[], facilitator: HttpFacilitator) {
  const liteKey = process.env.LITEAPI_KEY ?? "";
  const make = (name: AgentName) => {
    const identity = ids.agents[name];
    const ctx = {
      identity,
      baseUrl: `http://localhost:${PORTS[name]}`,
      facilitator,
      usdcTokenId: net.usdcTokenId,
      executorId: DEPLOYMENTS.testnet.mandateRegistryId,
      refund: refunder(identity),
    };
    if (name === "skyhop")
      return createSpecialist(skyhop(new DuffelClient(process.env.DUFFEL_ACCESS_TOKEN ?? "")), ctx);
    if (name === "airnest") return createSpecialist(airnest(new LiteFlightsClient(liteKey)), ctx);
    const manage = {
      bookings: new LiteHotelBookings(liteKey),
      store: new JsonStore<BookingRecord>(STAYWISE_STORE),
      arkiv: arkivReader(),
    };
    return createSpecialist(staywise(new LiteApiClient(liteKey), manage), ctx);
  };
  const started = which.map((name) => {
    const s = make(name);
    return { s, server: serve({ fetch: s.app.fetch, port: PORTS[name] }) };
  });
  for (const { s } of started) {
    const r = await s.publish();
    console.log(
      `   ${s.name} ${r.alreadyListed ? "already listed on Arkiv" : `listed on Arkiv ${ARKIV_EXPLORER.tx(r.txHash)}`}`,
    );
  }
  return {
    stop: () => {
      for (const { server } of started) server.close();
    },
  };
}

/** The human gives the orchestrator a budget: a mandate on Hedera, payable only to these agents. */
export async function createMandate(budget: bigint, perPaymentCap: bigint, payees: AgentName[]) {
  const owner = privateKeyToAccount(operatorKey);
  const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
  const usdc = tokenIdToEvmAddress(net.usdcTokenId);
  if ((await mc.allowance(usdc, owner.address)) < 1_000_000n)
    await mc.approve(owner, usdc, 2_000_000n);
  const { id, receipt } = await mc.createMandate(owner, {
    agent: ids.orchestrator.evm,
    token: usdc,
    budget,
    perPaymentCap,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    payees: payees.map((p) => ids.agents[p].evm),
  });
  console.log(
    `   mandate #${id}: up to ${Number(budget) / 1e6} USDC, only to ${payees.join(", ")}  ${tx(receipt.transactionHash)}`,
  );
  return { mandateId: id, mc };
}

/** Everything the orchestrator needs to pay agents and keep the public record. */
export async function orchestratorDeps(mandateId: bigint, mc: MandateClient): Promise<HireDeps> {
  return {
    arkiv: arkivReader(),
    buyerWriter: arkivWriter(ids.orchestrator.key),
    platformWriter: arkivWriter(operatorKey),
    payingFetch: createPayingFetch({
      agent: privateKeyToAccount(ids.orchestrator.key),
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
    inrRates: await fetchInrRates(),
    log,
  };
}

export function printExplanation(e: Explanation) {
  console.log(`\n   ${e.headline}`);
  for (const line of e.itinerary) console.log(`   • ${line}`);
  if (e.spends.length) console.log("   Spends:");
  for (const s of e.spends) console.log(`   • ${s.what}: ${s.amountUsdc} USDC — ${s.why}`);
  for (const c of e.caveats) console.log(`   ⚠ ${c}`);
}
