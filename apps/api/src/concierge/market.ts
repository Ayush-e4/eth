import { type ArkivReader, arkivReader, findAgents, findListings } from "@eth/arkiv";
import type { Card } from "@eth/shared";

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
export function arkivMarket(reader: ArkivReader = arkivReader()): Market {
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
