import { z } from "zod";
import type { Trip } from "../trip";
import { askStructured } from "./claude";
import type { Hire } from "./hire";

export const ExplanationSchema = z.object({
  headline: z.string(),
  itinerary: z.array(z.string()),
  spends: z.array(z.object({ what: z.string(), amountUsdc: z.string(), why: z.string() })),
  caveats: z.array(z.string()),
});

export type Explanation = z.infer<typeof ExplanationSchema>;

const SYSTEM = `You explain to a traveller what their AI agents just did, in plain friendly English.
- itinerary: short bullet lines (flight, hotel), using only facts from the data.
- spends: one entry per agent fee paid in USDC, with a one-sentence "why" (e.g. cheapest live quote, other agents skipped and why).
- caveats: say clearly these are SANDBOX bookings (no real tickets or rooms), plus anything that failed.
Never invent prices, times, names or booking references that are not in the data.`;

/** "Why did my agent spend this?" — Claude summarises the run from the recorded facts. */
export function explainRun(trip: Trip, hires: Hire[], failures: string[]): Promise<Explanation> {
  const facts = {
    trip,
    hires: hires.map((h) => ({
      skill: h.skill,
      agent: h.agent,
      quote: h.quoteNote,
      feeUsdc: (Number(h.feeUnits) / 1e6).toFixed(2),
      hederaTx: h.hederaTx,
      result: h.result,
      skippedCandidates: h.rejected,
    })),
    failures,
  };
  return askStructured({
    schema: ExplanationSchema,
    system: SYSTEM,
    user: JSON.stringify(facts, null, 2),
    effort: "low",
  });
}
