// Shared wiring for the demo scripts: facilitator, specialist agents, a mandate, payment plumbing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ARKIV_EXPLORER,
  arkivReader,
  arkivWriter,
  type Decoded,
  openTasks,
  type Task,
} from "@eth/arkiv";
import { createClient, loadConfig, NETWORKS, transferToken } from "@eth/hedera";
import {
  DEPLOYMENTS,
  hederaTestnet,
  MandateClient,
  mandateRegistryAbi,
  tokenIdToEvmAddress,
} from "@eth/mandates";
import { DuffelClient, LiteApiClient, LiteFlightsClient, LiteHotelBookings } from "@eth/travel";
import { createPayingFetch, HttpFacilitator, MirrorResolver } from "@eth/x402";
import { serve } from "@hono/node-server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadIdentities, type SpecialistIdentity } from "../src/identities";
import type { Explanation } from "../src/orchestrator/explain";
import { buy, type HireDeps } from "../src/orchestrator/hire";
import { fetchInrRates } from "../src/orchestrator/procure";
import { collectQuotes } from "../src/orchestrator/quotes";
import { airnest } from "../src/specialists/airnest";
import { priceGuard, type Watch } from "../src/specialists/priceguard";
import { createSpecialist } from "../src/specialists/server";
import { skyhop } from "../src/specialists/skyhop";
import { staywise } from "../src/specialists/staywise";
import type { BookingRecord } from "../src/specialists/staywise-manage";
import { tripmint } from "../src/specialists/tripmint";
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

type AgentName = "skyhop" | "airnest" | "staywise" | "priceguard" | "tripmint";
const PORTS: Record<AgentName, number> = {
  skyhop: 8411,
  staywise: 8412,
  airnest: 8413,
  priceguard: 8414,
  tripmint: 8415,
};
const BIDDERS = new Set<AgentName>(["skyhop", "airnest", "staywise"]);
const PRICEGUARD_STORE = fileURLToPath(new URL("../.priceguard.local.json", import.meta.url));

/** Starts the chosen specialist agents and lists them on Arkiv. */
export async function startAgents(
  which: AgentName[],
  facilitator: HttpFacilitator,
  opts: { simulateDropPercent?: number } = {},
) {
  const liteKey = process.env.LITEAPI_KEY ?? "";
  let guard: ReturnType<typeof priceGuard> | undefined;
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
    if (name === "tripmint") return createSpecialist(tripmintFor(identity), ctx);
    if (name === "priceguard") {
      guard = priceGuard(ctx, {
        store: new JsonStore<Watch>(PRICEGUARD_STORE),
        inrPerUsdc: async () => (await fetchInrRates()).USDC ?? 0,
      });
      return guard;
    }
    const manage = {
      bookings: new LiteHotelBookings(liteKey),
      store: new JsonStore<BookingRecord>(STAYWISE_STORE),
      arkiv: arkivReader(),
      simulateDropPercent: opts.simulateDropPercent, // sandbox demos only; labelled SIMULATED
    };
    return createSpecialist(staywise(new LiteApiClient(liteKey), manage), ctx);
  };
  const started = which.map((name) => {
    const s = make(name);
    return { s, server: serve({ fetch: s.app.fetch, port: PORTS[name] }) };
  });
  const unwatch: (() => void)[] = [];
  const bidders: { considerTask: (t: Decoded<Task>, log: (l: string) => void) => void }[] = [];
  for (const [i, { s }] of started.entries()) {
    const r = await s.publish();
    console.log(
      `   ${s.name} ${r.alreadyListed ? "already listed on Arkiv" : `listed on Arkiv ${ARKIV_EXPLORER.tx(r.txHash)}`}`,
    );
    if (BIDDERS.has(which[i] as AgentName) && "considerTask" in s) bidders.push(s);
  }
  // Flight and hotel agents also bid on open tasks posted to Arkiv. One shared read of the
  // board for all of them keeps us well inside Arkiv's query budget.
  if (bidders.length) unwatch.push(watchBoard(bidders));
  return {
    priceGuard: guard,
    stop: () => {
      for (const u of unwatch) u();
      for (const { server } of started) server.close();
    },
  };
}

const BOARD_EVERY_MS = 15_000;

/** Reads Arkiv's open tasks every 15 s and offers each to every bidding agent. */
function watchBoard(
  bidders: { considerTask: (t: Decoded<Task>, log: (l: string) => void) => void }[],
) {
  const reader = arkivReader();
  const tick = () =>
    openTasks(reader)
      .then((tasks) => {
        for (const t of tasks) for (const b of bidders) b.considerTask(t, log);
      })
      .catch((err) => log(`board read failed: ${String(err).slice(0, 120)}`));
  const timer = setInterval(() => void tick(), BOARD_EVERY_MS);
  void tick();
  return () => clearInterval(timer);
}

/** TripMint hires agents itself: it reads mandates and pays under the sub-mandates it's given. */
function tripmintFor(identity: SpecialistIdentity) {
  const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
  const registry = DEPLOYMENTS.testnet.mandateRegistry;
  const quoteDeps = async () => ({
    arkiv: arkivReader(),
    evm: mc.publicClient,
    registry,
    inrRates: await fetchInrRates(),
    log,
  });
  return tripmint({
    me: identity.evm,
    quoteDeps,
    async readMandate(id, payees) {
      const m = await mc.getMandate(id);
      const allowed = await Promise.all(
        payees.map((p) =>
          mc.publicClient.readContract({
            address: registry,
            abi: mandateRegistryAbi,
            functionName: "isPayeeAllowed",
            args: [id, p],
          }),
        ),
      );
      return {
        agent: m.agent,
        active: await mc.isActive(id),
        remaining: await mc.remaining(id),
        allowed: allowed.every(Boolean),
      };
    },
    async hireDeps(delegation) {
      const mandateId = BigInt(delegation.mandateId);
      const writer = arkivWriter(identity.key); // TripMint keeps its own public records
      return {
        ...(await quoteDeps()),
        buyerWriter: writer,
        platformWriter: writer,
        payingFetch: createPayingFetch({
          agent: privateKeyToAccount(identity.key),
          mandateId,
          payer: delegation.payer,
          executor: DEPLOYMENTS.testnet.mandateRegistryId,
          executorEvm: registry,
          chainId: hederaTestnet.id,
          resolver: new MirrorResolver(net.mirrorUrl),
          maxAmount: 100_000n,
        }),
        mandateId,
        payer: delegation.payer,
      };
    },
    collect: collectQuotes,
    purchase: buy,
  });
}

/** The human gives the orchestrator a budget: a mandate on Hedera, payable only to these agents. */
export async function createMandate(budget: bigint, perPaymentCap: bigint, payees: AgentName[]) {
  const owner = privateKeyToAccount(operatorKey);
  const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
  const usdc = tokenIdToEvmAddress(net.usdcTokenId);
  // The registry pulls fees from the owner's account via an allowance: keep it ≥ this budget.
  if ((await mc.allowance(usdc, owner.address)) < budget)
    await mc.approve(owner, usdc, budget * 2n);
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
export async function orchestratorDeps(
  mandateId: bigint,
  mc: MandateClient,
  maxAmount = 100_000n, // largest single payment this run may make (USDC base units)
): Promise<HireDeps> {
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
      maxAmount,
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
