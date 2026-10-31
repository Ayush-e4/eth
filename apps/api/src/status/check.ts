import { type ArkivReader, arkivReader } from "@eth/arkiv";
import { and, desc, eq, gt, sum } from "drizzle-orm";
import { balances } from "../account/balances";
import type { Market } from "../concierge/market";
import type { Db } from "../db/client";
import { hires, mandates } from "../db/schema";
import type { DemoQuotas } from "../demo/quotas";
import type { HiringEnv } from "../hiring/env";

export interface Probe {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Below these the shared wallet is "low" (demo hires pause lower still: see demo/quotas.ts). */
export const LOW = { usdcUnits: 1_000_000n, hbarTinybars: 20n * 100_000_000n };

const CACHE_MS = 30_000;
const TIMEOUT_MS = 4_000;

/**
 * Is everything up? Pings the payment service, every agent on the market, Hedera's mirror and
 * Arkiv; reads the shared demo wallet's balances, today's demo spending and the latest payment.
 * Cached for 30 s, so a busy status page doesn't hammer anyone. Web2 analogy: a status page.
 */
export function statusCheck(
  db: Db,
  env: HiringEnv | null,
  d: {
    market: Market;
    quotas?: DemoQuotas | null;
    facilitatorUrl?: string;
    reader?: ArkivReader;
    fetchImpl?: typeof fetch;
  },
) {
  const fetchImpl = d.fetchImpl ?? fetch;
  const reader = d.reader ?? arkivReader();
  const facilitatorUrl = d.facilitatorUrl ?? process.env.FACILITATOR_URL ?? "http://localhost:8402";
  let cached: { at: number; value: Promise<Awaited<ReturnType<typeof run>>> } | null = null;

  const ping = async (name: string, url: string, detail?: string): Promise<Probe> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    return { name, ok: !!res?.ok, ...(detail ? { detail } : {}) };
  };

  async function wallet() {
    if (!env) return null;
    const b = await balances(env.mirrorUrl, env.demo.account, env.usdcTokenId, fetchImpl).catch(
      () => null,
    );
    if (!b) return { account: env.demo.account, reachable: false, warnings: [] as string[] };
    const usdc = BigInt(b.usdcUnits);
    const hbar = BigInt(b.hbarTinybars);
    const warnings: string[] = [];
    if (usdc < LOW.usdcUnits) warnings.push("test USDC is low: top it up at faucet.circle.com");
    if (hbar < LOW.hbarTinybars)
      warnings.push("HBAR for network fees is low: top it up at portal.hedera.com");
    return { account: env.demo.account, reachable: true, ...b, warnings };
  }

  async function run() {
    const agents = await d.market.agents().catch(() => null);
    const [services, arkivHead, w, demoFees, last] = await Promise.all([
      Promise.all([
        ping("Payment service (x402 facilitator)", `${facilitatorUrl}/health`),
        ...(agents ?? []).map((a) => ping(a.name, a.endpoint, a.skill)),
      ]),
      reader.getBlockNumber().catch(() => null),
      wallet(),
      db
        .select({ units: sum(hires.feeUnits) })
        .from(hires)
        .innerJoin(mandates, eq(mandates.mandateId, hires.mandateId))
        .where(and(eq(mandates.demo, true), gt(hires.createdAt, new Date(Date.now() - 86_400_000))))
        .then(([r]) => BigInt(r?.units ?? 0)),
      db
        .select({
          at: hires.createdAt,
          agent: hires.title,
          feeUnits: hires.feeUnits,
          hederaTx: hires.hederaTx,
        })
        .from(hires)
        .orderBy(desc(hires.createdAt))
        .limit(1)
        .then(([r]) => r ?? null),
    ]);
    const networks: Probe[] = [
      { name: "Hedera testnet", ok: !!w?.reachable, detail: "mirror node" },
      {
        name: "Arkiv (Rabdi)",
        ok: arkivHead !== null,
        ...(arkivHead !== null ? { detail: `block ${arkivHead}` } : {}),
      },
      { name: "Agent market", ok: agents !== null, detail: `${agents?.length ?? 0} agents listed` },
    ];
    const all = [...services, ...networks];
    return {
      at: new Date().toISOString(),
      ok: all.every((p) => p.ok) && !w?.warnings.length,
      services,
      networks,
      wallet: w,
      demo: d.quotas
        ? { feesTodayUnits: demoFees.toString(), budgetUnits: d.quotas.feeUnitsPerDay.toString() }
        : null,
      lastPayment: last && {
        at: last.at.toISOString(),
        agent: last.agent.split(" — ")[0],
        feeUnits: last.feeUnits.toString(),
        hederaTx: last.hederaTx,
      },
      logTopic: env?.log?.topicId ?? null,
    };
  }

  return {
    /** The current status (recomputed at most every 30 s). */
    get() {
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        cached = { at: Date.now(), value: run() };
        cached.value.catch(() => {
          cached = null;
        });
      }
      return cached.value;
    },

    /** The shared demo wallet's test USDC, or null if it can't be read right now. */
    async demoUsdc() {
      const w = (await this.get()).wallet;
      return w?.reachable && "usdcUnits" in w ? BigInt(w.usdcUnits) : null;
    },
  };
}

export type StatusCheck = ReturnType<typeof statusCheck>;
