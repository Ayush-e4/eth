import { eq } from "drizzle-orm";
import type { Market } from "../concierge/market";
import type { Db } from "../db/client";
import { hiddenAgents } from "../db/schema";

const REFRESH_MS = 30_000;

/**
 * Agents an admin hid (the ops page's kill switch for one agent). Read on every quote, so the
 * set is kept in memory and refreshed after each change (and every 30 s, for other servers).
 */
export function hiddenAgentStore(db: Db) {
  let set = new Set<string>();
  let at = 0;
  const refresh = async () => {
    const rows = await db.select({ agent: hiddenAgents.agent }).from(hiddenAgents);
    set = new Set(rows.map((r) => r.agent));
    at = Date.now();
  };
  const fresh = async () => {
    if (Date.now() - at > REFRESH_MS) await refresh().catch(() => {});
  };

  return {
    /** Whether this agent is hidden (cached; refreshed in the background when stale). */
    isHidden(agent: string) {
      void fresh();
      return set.has(agent.toLowerCase());
    },
    async list() {
      await fresh();
      return db.select().from(hiddenAgents);
    },
    async hide(agent: string, name: string, reason: string, by: string) {
      await db
        .insert(hiddenAgents)
        .values({ agent: agent.toLowerCase(), name, reason, hiddenBy: by })
        .onConflictDoUpdate({ target: hiddenAgents.agent, set: { reason, hiddenBy: by } });
      await refresh();
    },
    async unhide(agent: string) {
      await db.delete(hiddenAgents).where(eq(hiddenAgents.agent, agent.toLowerCase()));
      await refresh();
    },
    refresh,
  };
}

export type HiddenAgents = ReturnType<typeof hiddenAgentStore>;

/** The market without hidden agents: what the Market page and the concierge see. */
export const visibleMarket = (market: Market, hidden: HiddenAgents): Market => ({
  agents: async (skill) => {
    const all = await market.agents(skill);
    await hidden.list(); // make sure the set is fresh before filtering
    return all.filter((a) => !hidden.isHidden(a.agent));
  },
});
