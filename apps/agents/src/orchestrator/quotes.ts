import { findListings, liveQuotes } from "@eth/arkiv";
import { mandateRegistryAbi } from "@eth/mandates";
import type { Trip } from "../trip";
import type { HireDeps } from "./hire";
import { type Candidate, describePriced, type Priced, rankByTotalCost } from "./procure";

const QUOTE_TIMEOUT_MS = 25_000;

/** One quote the buyer can act on: signed on Arkiv, from a payee the mandate allows. */
export interface QuoteOption extends Candidate {
  endpoint: string; // the agent's service, from its Arkiv listing
  priced?: Priced; // set when the item price could be converted to INR
}

/** Everything learned while asking one skill's agents for quotes. */
export interface QuoteRound {
  skill: string;
  task: string;
  options: QuoteOption[]; // best first: comparable total cost, then the rest by agent fee
  bestReason: string; // why options[0] is the default pick
  skipped: string[]; // agents that couldn't be asked or didn't quote, and why
}

/**
 * Discover agents for a skill on Arkiv → keep only payees the mandate allows → ask each for a
 * quote → read the live, signed quotes back from Arkiv → rank by total cost (item + fee, INR).
 */
export async function collectQuotes(
  skill: string,
  task: string,
  trip: Trip,
  d: HireDeps,
): Promise<QuoteRound> {
  const skipped: string[] = [];
  const listings = await findListings(d.arkiv, { skill });
  d.log(`[${skill}] ${listings.length} listing(s) on Arkiv`);

  const allowed = [];
  for (const l of listings) {
    const ok = await d.evm.readContract({
      address: d.registry,
      abi: mandateRegistryAbi,
      functionName: "isPayeeAllowed",
      args: [d.mandateId, l.record.agent],
    });
    if (ok) allowed.push(l);
    else
      skipped.push(
        `${l.record.title} (${l.record.agent.slice(0, 8)}…): not an allowed payee in the mandate`,
      );
  }
  if (allowed.length === 0)
    throw new Error(`No ${skill} agent is an allowed payee in mandate #${d.mandateId}`);

  await Promise.all(
    allowed.map(async (l) => {
      try {
        const res = await fetch(`${l.record.endpoint}/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task, trip }),
          signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        skipped.push(`${l.record.title}: no quote (${String(err)})`);
      }
    }),
  );

  // Prices come from the signed Arkiv quote, not the HTTP reply, so the decision is auditable.
  const byAgent = new Map(allowed.map((l) => [l.record.agent.toLowerCase(), l]));
  const quotes = (await liveQuotes(d.arkiv, task)).filter(
    (q) => q.record.skill === skill && byAgent.has(q.record.agent.toLowerCase()),
  );
  const candidates: Candidate[] = quotes.map((q) => ({
    key: q.key,
    agent: q.record.agent,
    title: byAgent.get(q.record.agent.toLowerCase())?.record.title ?? q.record.agent,
    note: q.record.note,
    feeUnits: q.record.priceUnits,
    itemTotal: q.record.itemTotal,
    itemCurrency: q.record.itemCurrency,
  }));
  const { priced, unpriced } = rankByTotalCost(candidates, d.inrRates);
  const endpointOf = (c: Candidate) => byAgent.get(c.agent.toLowerCase())?.record.endpoint ?? "";
  const options: QuoteOption[] = [
    ...priced.map((p) => ({ ...p, endpoint: endpointOf(p), priced: p })),
    ...unpriced.map((u) => ({ ...u, endpoint: endpointOf(u) })),
  ];
  const winner = priced[0];
  const bestReason = winner
    ? `lowest total of ${priced.length} comparable quote(s): ${describePriced(winner)}`
    : `cheapest agent fee (no comparable item prices among ${unpriced.length} quote(s))`;
  d.log(`[${skill}] ${options.length} live quote(s); best: ${options[0]?.title ?? "none"}`);
  return { skill, task, options, bestReason, skipped };
}

/** Why each option other than the chosen one lost — for the record and the explanation. */
export function otherOptions(round: QuoteRound, chosenKey: string): string[] {
  return [
    ...round.skipped,
    ...round.options
      .filter((o) => o.key !== chosenKey)
      .map((o) =>
        o.priced ? `${o.title}: ${describePriced(o.priced)}` : `${o.title}: no comparable price`,
      ),
  ];
}
