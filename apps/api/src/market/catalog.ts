import { type ArkivReader, agentRecords, arkivReader, deliveriesBy, liveTasks } from "@eth/arkiv";
import { count, max, sum } from "drizzle-orm";
import type { Market, MarketAgent } from "../concierge/market";
import type { Db } from "../db/client";
import { hires } from "../db/schema";
import type { StatusCheck } from "../status/check";

const CACHE_MS = 30_000;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type CatalogAgent = MarketAgent & {
  up: boolean | null; // from the status check (null: unknown yet)
  jobsHere: number; // paid hires through AgentNet
  earnedHereUnits: string; // what AgentNet buyers paid it, USDC base units
  lastJobAt: string | null;
};

/**
 * The Market page's view of the open market: every agent listed on Arkiv (what it signed), its
 * reviews on ERC-8004, whether it's up, and what it has done through AgentNet. Cached 30 s.
 * Everything here is public anyway (Arkiv, Hedera, our public log), so no sign-in is needed.
 */
export function marketCatalog(
  db: Db,
  d: {
    market: Market;
    status?: StatusCheck | null;
    reader?: ArkivReader;
    fetchImpl?: typeof fetch;
  },
) {
  const reader = d.reader ?? arkivReader();
  const fetchImpl = d.fetchImpl ?? fetch;
  let cached: { at: number; value: Promise<Awaited<ReturnType<typeof build>>> } | null = null;

  async function build() {
    const [agents, status, done, tasks] = await Promise.all([
      d.market.agents(),
      d.status?.get().catch(() => null),
      db
        .select({
          agent: hires.agent,
          n: count(),
          units: sum(hires.feeUnits),
          last: max(hires.createdAt),
        })
        .from(hires)
        .groupBy(hires.agent),
      liveTasks(reader).catch(() => []),
    ]);
    const list: CatalogAgent[] = agents.map((a) => {
      const mine = done.filter((h) => same(h.agent, a.agent));
      const last = mine.map((h) => h.last).filter((t): t is Date => !!t);
      return {
        ...a,
        up: status?.services.find((s) => s.name === a.name)?.ok ?? null,
        jobsHere: mine.reduce((n, h) => n + h.n, 0),
        earnedHereUnits: mine.reduce((n, h) => n + BigInt(h.units ?? 0), 0n).toString(),
        lastJobAt: last.length ? new Date(Math.max(...last.map(Number))).toISOString() : null,
      };
    });
    return { agents: list, openTasks: tasks.filter((t) => t.record.status === "open").length };
  }

  return {
    list() {
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        cached = { at: Date.now(), value: build() };
        cached.value.catch(() => {
          cached = null;
        });
      }
      return cached.value;
    },

    /** One agent in full: what it accepts, where it's paid, its signed records and track record. */
    async agent(address: string) {
      const a = (await this.list()).agents.find((x) => same(x.agent, address));
      if (!a) return null;
      const who = a.agent as `0x${string}`;
      const [records, deliveries, profile] = await Promise.all([
        agentRecords(reader, who).catch(() => ({ profiles: [], listings: [] })),
        deliveriesBy(reader, who, 50).catch(() => []),
        fetchImpl(a.endpoint, { signal: AbortSignal.timeout(4000) })
          .then((r) => (r.ok ? (r.json() as Promise<{ inputSchema?: unknown }>) : null))
          .catch(() => null),
      ]);
      const p = records.profiles.find((x) => x.record.skill === a.skill) ?? records.profiles[0];
      const l = records.listings.find((x) => x.record.skill === a.skill) ?? records.listings[0];
      return {
        ...a,
        hederaAccount: p?.record.hederaAccount ?? null,
        profileKey: p?.key ?? null,
        listingKey: l?.key ?? null,
        inputSchema: profile?.inputSchema ?? null,
        delivered: deliveries.filter((x) => x.record.status === "delivered").length,
        refunded: deliveries.filter((x) => x.record.status === "refunded").length,
        deliveries: deliveries.slice(0, 10).map((x) => ({
          key: x.key,
          task: x.record.task,
          status: x.record.status,
          ...(x.record.refundTx ? { refundTx: x.record.refundTx } : {}),
        })),
      };
    },
  };
}

export type MarketCatalog = ReturnType<typeof marketCatalog>;
