import { type ArkivReader, arkivReader, findAgents, findListings } from "@eth/arkiv";
import { Erc8004Client } from "@eth/mandates";
import type { Card } from "@eth/shared";
import type { Address } from "viem";

export type MarketAgent = Extract<Card, { type: "agents" }>["agents"][number];

/** What the concierge can see of the open market. */
export interface Market {
  agents(skill?: string): Promise<MarketAgent[]>;
}

/**
 * The market as Arkiv holds it: agent profiles joined to their listings (price, pitch). Only
 * records whose Arkiv creator is the agent itself are returned (the reader checks that), and
 * an agent without a live listing isn't hireable, so it's left out.
 */
export function arkivMarket(
  reader: ArkivReader = arkivReader(),
  // Whose reviews count (the wallets that pay agents for us); none means no reputation shown.
  raters: Address[] = [],
  erc = new Erc8004Client(),
): Market {
  /** ERC-8004 identity plus reviews from our raters only (the registry refuses unfiltered). */
  const identity = async (id: bigint | undefined) => {
    if (id === undefined) return undefined;
    const s = raters.length ? await erc.summary(id, raters).catch(() => null) : null;
    return { erc8004Id: id.toString(), paidJobs: s?.count ?? 0, averageScore: s?.average ?? null };
  };
  return {
    async agents(skill) {
      const profiles = await findAgents(reader, skill ? { skill } : {});
      const skills = [...new Set(profiles.map((p) => p.record.skill))];
      const listings = (
        await Promise.all(skills.map((s) => findListings(reader, { skill: s })))
      ).flat();
      const out: MarketAgent[] = [];
      const seen = new Set<string>();
      for (const p of profiles) {
        const agent = p.record.agent.toLowerCase();
        const listing = listings.find(
          (l) => l.record.agent.toLowerCase() === agent && l.record.skill === p.record.skill,
        );
        const id = `${agent}:${p.record.skill}`;
        if (!listing || seen.has(id)) continue;
        seen.add(id);
        out.push({
          identity: await identity(p.record.erc8004Id),
          name: p.record.name,
          skill: p.record.skill,
          title: listing.record.title,
          description: p.record.description,
          priceUnits: listing.record.priceUnits.toString(),
          agent: p.record.agent,
          endpoint: listing.record.endpoint,
        });
      }
      // Arkiv doesn't stop two agents using one name; when they do, show whose is whose.
      const count = new Map<string, number>();
      for (const a of out) count.set(a.name, (count.get(a.name) ?? 0) + 1);
      return out.map((a) =>
        (count.get(a.name) ?? 0) > 1
          ? { ...a, name: `${a.name} · ${a.agent.slice(0, 6)}…${a.agent.slice(-4)}` }
          : a,
      );
    },
  };
}
