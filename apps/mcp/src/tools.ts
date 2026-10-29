import type { Hire, QuoteOption, QuoteRound } from "@eth/agents/hiring";

export interface MarketAgent {
  name: string;
  skill: string;
  title: string;
  description: string;
  feeUnits: bigint;
  agent: string;
  endpoint: string;
}

/** What the tools need from the outside world; the real wiring is in deps.ts, tests fake it. */
export interface ToolDeps {
  agents(skill?: string): Promise<MarketAgent[]>;
  quotes(skill: string, task: string, input: unknown): Promise<QuoteRound>;
  /** Null when no mandate is set up. */
  hire: ((round: QuoteRound, option: QuoteOption, reason: string) => Promise<Hire>) | null;
  budget: (() => Promise<{ remainingUnits: bigint; expiresAt: number }>) | null;
  fetchProfile(endpoint: string): Promise<{ inputSchema?: unknown } | null>;
}

const QUOTE_TTL_MS = 170_000; // agents hold quotes for 3 minutes
const usdc = (u: bigint) => `${(Number(u) / 1e6).toFixed(2)} USDC`;
const short = (title: string) => title.split(" — ")[0] ?? title;
const json = (v: unknown, max = 4000) => {
  const s = JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const NO_MANDATE =
  "Paying is off: no spending limit is set up for this MCP server. Run `pnpm --filter @eth/mcp setup-mandate` and restart the client.";

/**
 * The market as tools. Browsing and quotes are free; `hire` pays the agent's fee over x402
 * from the mandate, which the chain caps (total, per payment, payees, expiry). Each returns text.
 */
export function marketTools(d: ToolDeps) {
  const held = new Map<string, { round: QuoteRound; option: QuoteOption; at: number }>();
  let next = 1;

  return {
    async findAgents({ skill }: { skill?: string }) {
      const list = await d.agents(skill);
      if (!list.length) return `No agent on the market offers ${skill ?? "anything"} right now.`;
      return json(
        list.map((a) => ({
          name: a.name,
          skill: a.skill,
          does: a.title,
          fee: usdc(a.feeUnits),
          agent: a.agent,
        })),
      );
    },

    async agentInput({ skill }: { skill: string }) {
      for (const a of await d.agents(skill)) {
        const profile = await d.fetchProfile(a.endpoint);
        if (profile?.inputSchema) return json(profile.inputSchema, 3000);
      }
      return `No ${skill} agent is reachable right now.`;
    },

    async getQuotes({ skill, input }: { skill: string; input: Record<string, unknown> }) {
      const task = `mcp-${Date.now().toString(36)}`;
      const round = await d.quotes(skill, task, input);
      const refs = round.options.map((option) => {
        const ref = `q${next++}`;
        held.set(ref, { round, option, at: Date.now() });
        return { ref, option };
      });
      return json({
        quotes: refs.map(({ ref, option: o }) => ({
          ref,
          agent: short(o.title),
          offer: o.note,
          fee: usdc(o.feeUnits),
          totalInr: o.priced ? Math.round(o.priced.totalInr) : undefined,
        })),
        best: refs[0]?.ref ?? null,
        why: round.bestReason,
        notAsked: round.skipped,
        next: refs.length
          ? "Show the user the options. Call hire with a ref only when they want it done."
          : undefined,
      });
    },

    async hire({ quote, reason }: { quote: string; reason: string }) {
      if (!d.hire) return NO_MANDATE;
      const h = held.get(quote);
      if (!h || Date.now() - h.at > QUOTE_TTL_MS)
        return `Quote ${quote} expired or doesn't exist. Get fresh quotes.`;
      held.delete(quote); // one hire per quote
      const done = await d.hire(h.round, h.option, reason);
      return json({
        status: "hired",
        agent: short(done.agentTitle),
        fee: usdc(done.feeUnits),
        paymentOnHashScan: `https://hashscan.io/testnet/transaction/${done.hederaTx}`,
        jobOnArkiv: `https://tiramisu.explorer.arkiv.network/entity/${done.jobKey}`,
        result: done.result,
        note: "Test mode: sandbox bookings and testnet USDC.",
      });
    },

    async budget() {
      if (!d.budget) return NO_MANDATE;
      const b = await d.budget();
      return `Left to spend: ${usdc(b.remainingUnits)}, until ${new Date(b.expiresAt * 1000).toISOString()}.`;
    },
  };
}
