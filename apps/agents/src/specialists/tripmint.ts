import type { Delegation, Subcontract } from "@eth/shared";
import type { Address } from "viem";
import type { buy, Hire, HireDeps } from "../orchestrator/hire";
import type { collectQuotes, QuoteDeps, QuoteOption, QuoteRound } from "../orchestrator/quotes";
import { type Trip, TripSchema } from "../trip";
import type { SpecialistDef } from "./server";

/** What TripMint planned when it quoted: the best flight and hotel, and the rounds they came from. */
export interface TripPlan {
  legs: { round: QuoteRound; pick: QuoteOption }[];
  at: number;
}

export interface TripMintDeps {
  me: Address; // TripMint's own EVM address: the agent of the sub-mandates it's given
  quoteDeps(): Promise<QuoteDeps>;
  /** What the chain says about a mandate, and whether it may pay these agents. */
  readMandate(
    id: bigint,
    payees: Address[],
  ): Promise<{ agent: Address; active: boolean; remaining: bigint; allowed: boolean }>;
  /** Paying and record-keeping as TripMint, under the sub-mandate it was given. */
  hireDeps(delegation: Delegation): Promise<HireDeps>;
  collect: typeof collectQuotes;
  purchase: typeof buy;
}

const SKILLS = ["flights", "hotels"] as const;
const FRESH_MS = 150_000; // sub-agents hold quotes 3 minutes; re-quote a little before that
const short = (title: string) => title.split(" — ")[0] ?? title;

/** The fees TripMint will pay the agents it hires: exactly what the buyer must delegate. */
export function subcontractOf(plan: TripPlan): Subcontract {
  return {
    budgetUnits: plan.legs.reduce((s, l) => s + l.pick.feeUnits, 0n).toString(),
    payees: plan.legs.map((l) => ({
      name: short(l.pick.title),
      skill: l.round.skill,
      agent: l.pick.agent,
    })),
  };
}

/**
 * TripMint: an agent that hires agents. It takes a whole trip, picks the best flight and hotel
 * from the market (quotes are free), and books both by hiring those agents itself. It pays them
 * from a sub-mandate: a slice of the user's limit the buyer grants for this job, checked on
 * Hedera before TripMint's own fee is taken. Fee: 0.05 USDC.
 */
export function tripmint(d: TripMintDeps): SpecialistDef<Trip, TripPlan, unknown> {
  // The best quote per skill that doesn't hire others itself (no chains of planners).
  const bestOf = (round: QuoteRound, agent?: string) =>
    round.options.find(
      (o) =>
        !o.subcontract &&
        o.agent.toLowerCase() !== d.me.toLowerCase() &&
        (!agent || o.agent.toLowerCase() === agent.toLowerCase()),
    );

  return {
    name: "TripMint",
    skill: "trips",
    title: "TripMint — plans a whole trip and books the flight and hotel for you",
    description:
      "Give it a trip; it compares flight and hotel agents on the market and hires the best of each, paying them from a slice of your limit.",
    input: TripSchema,
    priceUnits: 50_000n,

    async quote({ task, input: trip }) {
      const qd = await d.quoteDeps();
      const legs = await Promise.all(
        SKILLS.map(async (skill) => {
          const round = await d.collect(skill, `${task.slice(0, 56)}-${skill[0]}`, trip, qd);
          const pick = bestOf(round);
          if (!pick) throw new Error(`no ${skill} agent could quote this trip`);
          return { round, pick };
        }),
      );
      const plan: TripPlan = { legs, at: Date.now() };
      const totalInr = legs.reduce((s, l) => s + (l.pick.priced?.totalInr ?? 0), 0);
      return {
        note: legs
          .map(
            (l) =>
              `${l.round.skill === "flights" ? "Flight" : "Hotel"}: ${l.pick.note} (${short(l.pick.title)})`,
          )
          .join("; ")
          .slice(0, 480),
        detail: plan,
        itemTotal: Math.round(totalInr),
        itemCurrency: "INR",
        subcontract: subcontractOf(plan),
      };
    },

    async check({ delegation }, plan) {
      if (!delegation)
        return "TripMint needs a sub-mandate (delegation) to pay the agents it hires";
      const need = subcontractOf(plan);
      const m = await d.readMandate(
        BigInt(delegation.mandateId),
        need.payees.map((p) => p.agent as Address),
      );
      if (m.agent.toLowerCase() !== d.me.toLowerCase())
        return "that sub-mandate isn't for TripMint";
      if (!m.active) return "that sub-mandate is revoked or expired";
      if (m.remaining < BigInt(need.budgetUnits)) return "that sub-mandate's budget is too small";
      if (!m.allowed) return "that sub-mandate doesn't allow the agents in the plan";
      return null;
    },

    async work({ input: trip, delegation }, plan) {
      const hd = await d.hireDeps(delegation as Delegation); // check() made sure it's there
      const hires: Hire[] = [];
      for (const leg of plan.legs) {
        let { round, pick } = leg;
        if (Date.now() - plan.at > FRESH_MS) {
          // Its quote may have lapsed: ask the same agent again (the sub-mandate only pays it).
          round = await d.collect(round.skill, `${round.task}r`.slice(0, 64), trip, hd);
          const again = bestOf(round, pick.agent);
          if (!again) throw new Error(`${short(pick.title)} no longer quotes this trip`);
          pick = again;
        }
        try {
          const label = `${round.skill} for ${trip.destinationName}, via TripMint`;
          hires.push(await d.purchase(round, pick, label, hd, "TripMint's pick: lowest total"));
        } catch (err) {
          if (!hires.length) throw err; // nothing booked: TripMint's fee is refunded
          return report(hires, delegation, String(err).slice(0, 300));
        }
      }
      return report(hires, delegation);
    },
  };
}

function report(hires: Hire[], delegation?: Delegation, failed?: string) {
  return {
    subMandateId: delegation?.mandateId,
    hires: hires.map((h) => ({
      skill: h.skill,
      agent: h.agent,
      title: short(h.agentTitle),
      note: h.quoteNote,
      feeUnits: h.feeUnits.toString(),
      hederaTx: h.hederaTx,
      jobKey: h.jobKey,
      result: h.result,
    })),
    ...(failed ? { failed } : {}),
  };
}
