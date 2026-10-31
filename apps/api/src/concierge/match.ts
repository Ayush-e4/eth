import type { Market, MarketAgent } from "./market";

const STOP = new Set(
  "a an the and or for to of in on at me my i we our you your it is be can that this with from need want please book find get some".split(
    " ",
  ),
);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
// "flight" ~ "flights", "pack" ~ "packing": compare the first five letters.
const alike = (a: string, b: string) => {
  const n = Math.min(5, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
};

/**
 * Agents whose skill, title or description fit what the user needs, best first. The market is
 * open, so skills are whatever agents call them: matching on their own words is how a new agent
 * ("laundry", "visa") gets found without anyone teaching the concierge about it.
 */
export function matchAgents(agents: MarketAgent[], need: string): MarketAgent[] {
  const want = words(need);
  if (!want.length) return [];
  const score = (a: MarketAgent) => {
    const has = (text: string) => {
      const ws = words(text);
      return want.filter((w) => ws.some((x) => alike(w, x))).length;
    };
    return 3 * has(a.skill) + 2 * has(`${a.name} ${a.title}`) + has(a.description);
  };
  return agents
    .map((a) => ({ a, s: score(a) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
}

const SUMMARY_MS = 120_000;
const MAX_SKILLS = 40;

/** One line per skill on the market (who offers it, what it does), for the concierge's prompt. */
export function marketSummary(market: Market) {
  let cached: { at: number; value: Promise<string> } | null = null;
  return () => {
    if (cached && Date.now() - cached.at < SUMMARY_MS) return cached.value;
    const value = market.agents().then((agents) => {
      const bySkill = new Map<string, MarketAgent[]>();
      for (const a of agents) bySkill.set(a.skill, [...(bySkill.get(a.skill) ?? []), a]);
      return [...bySkill]
        .slice(0, MAX_SKILLS)
        .map(([skill, as]) => {
          const what = (as[0]?.title.split(" — ")[1] ?? as[0]?.description ?? "").slice(0, 90);
          return `- ${skill}: ${as.map((a) => a.name).join(", ")} (${what})`;
        })
        .join("\n");
    });
    value.catch(() => {
      cached = null;
    });
    cached = { at: Date.now(), value };
    return value;
  };
}
