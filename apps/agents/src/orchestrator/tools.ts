import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Trip } from "../trip";
import { type Explanation, ExplanationSchema } from "./explain";
import { buy, type Hire, type HireDeps } from "./hire";
import { describePriced } from "./procure";
import { collectQuotes, type QuoteRound } from "./quotes";

export const SKILLS = ["flights", "hotels"] as const;
const MAX_ATTEMPTS = 2; // per skill: one retry with another quote after a failed (refunded) hire

/** What the agent has done in one run. Tools read and write it; code, not Claude, enforces rules. */
export interface RunState {
  task: string;
  trip: Trip;
  rounds: Map<string, QuoteRound>;
  hires: Map<string, Hire>;
  attempts: Map<string, number>;
  failures: string[];
  explanation?: Explanation;
}

export function newRunState(task: string, trip: Trip): RunState {
  return { task, trip, rounds: new Map(), hires: new Map(), attempts: new Map(), failures: [] };
}

/** The orchestrator's own tools. Money only moves through hire_agent, and only under its checks. */
export function tripTools(state: RunState, d: HireDeps) {
  const getQuotes = betaZodTool({
    name: "get_quotes",
    description:
      "Ask every marketplace agent that sells this skill, and that the traveller's mandate allows paying, for a quote. Returns live quotes signed on Arkiv, ranked by total cost to the traveller (item + agent fee, in INR). Quotes expire after ~3 minutes.",
    inputSchema: z.object({ skill: z.enum(SKILLS) }),
    run: async ({ skill }) => {
      const round = await collectQuotes(skill, state.task, state.trip, d);
      state.rounds.set(skill, round);
      return JSON.stringify({
        skill,
        defaultPick: round.options[0]?.key ?? null,
        defaultReason: round.bestReason,
        options: round.options.map((o, i) => ({
          rank: i + 1,
          quoteKey: o.key,
          agent: o.title,
          offer: o.note,
          totalInr: o.priced ? Math.round(o.priced.totalInr) : null,
          itemInr: o.priced ? Math.round(o.priced.itemInr) : null,
          agentFeeUsdc: Number(o.feeUnits) / 1e6,
        })),
        skipped: round.skipped,
      });
    },
  });

  const hireAgent = betaZodTool({
    name: "hire_agent",
    description:
      "Irreversible: pays the agent's fee in USDC from the traveller's mandate and has it book the quoted option. Use a quoteKey from your latest get_quotes for that skill, and say why you chose it — especially if it is not rank 1.",
    inputSchema: z.object({
      skill: z.enum(SKILLS),
      quoteKey: z.string(),
      reason: z.string().min(5).max(300),
    }),
    run: async ({ skill, quoteKey, reason }) => {
      if (state.hires.has(skill)) throw new Error(`${skill} is already booked for this trip.`);
      const round = state.rounds.get(skill);
      if (!round) throw new Error(`Call get_quotes for ${skill} first.`);
      const pick = round.options.find((o) => o.key === quoteKey);
      if (!pick) throw new Error(`Unknown quoteKey for ${skill}; use one from get_quotes.`);
      const attempt = (state.attempts.get(skill) ?? 0) + 1;
      if (attempt > MAX_ATTEMPTS) {
        throw new Error(`Already tried ${MAX_ATTEMPTS} ${skill} hires; stop and report it.`);
      }
      state.attempts.set(skill, attempt);
      const rank = round.options.indexOf(pick) + 1;
      const price = pick.priced ? describePriced(pick.priced) : "no comparable price";
      const choice = `${reason} [rank ${rank} of ${round.options.length}: ${price}]`;
      try {
        const hire = await buy(round, pick, state.trip, d, choice);
        state.hires.set(skill, hire);
        const { departDate, returnDate, returnFlight } = state.trip;
        const dates =
          skill === "hotels"
            ? { checkin: departDate, checkout: returnDate }
            : { outbound: departDate, ...(returnFlight ? { return: returnDate } : {}) };
        return JSON.stringify({
          booked: true,
          agent: pick.title,
          offer: pick.note,
          dates,
          feeUsdc: Number(pick.feeUnits) / 1e6,
          hederaTx: hire.hederaTx,
          booking: hire.result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.failures.push(message);
        round.options = round.options.filter((o) => o.key !== quoteKey); // that quote is used up
        throw new Error(
          `${message}\nThat quote is used up. You may hire another option from the same get_quotes result once.`,
        );
      }
    },
  });

  const finish = betaZodTool({
    name: "finish",
    description:
      "Call exactly once, last: tell the traveller what was booked and why each fee was paid, using only facts from tool results.",
    inputSchema: ExplanationSchema,
    run: async (explanation) => {
      state.explanation = explanation;
      return "Saved. You are done — do not call any more tools.";
    },
  });

  return { getQuotes, hireAgent, finish };
}
