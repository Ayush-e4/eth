import {
  type ArkivReader,
  type ArkivWriter,
  findListings,
  liveQuotes,
  openJob,
  rateAgent,
  recordReceipt,
} from "@eth/arkiv";
import { mandateRegistryAbi } from "@eth/mandates";
import type { PaidResponse } from "@eth/x402";
import type { PublicClient } from "viem";
import type { Trip } from "../trip";

export interface HireDeps {
  arkiv: ArkivReader;
  buyerWriter: ArkivWriter; // orchestrator's own wallet (jobs, ratings)
  platformWriter: ArkivWriter; // trusted wallet that publishes receipts
  payingFetch: (url: string, init?: RequestInit) => Promise<PaidResponse>;
  evm: PublicClient; // Hedera JSON-RPC, to read the mandate
  registry: `0x${string}`;
  mandateId: bigint;
  payer: string; // mandate owner's Hedera account
  log: (line: string) => void;
}

export interface Hire {
  skill: string;
  agent: `0x${string}`;
  quoteNote: string;
  feeUnits: bigint;
  hederaTx: string;
  jobKey: `0x${string}`;
  result: unknown;
  rejected: string[]; // why other candidates were skipped
}

const QUOTE_TIMEOUT_MS = 25_000;

/**
 * Hires the best agent for one skill: discover on Arkiv → keep only payees the mandate allows →
 * collect quotes → pick the cheapest live quote → pay its /work endpoint over x402 →
 * record job, receipt and rating on Arkiv.
 */
export async function hire(skill: string, task: string, trip: Trip, d: HireDeps): Promise<Hire> {
  const rejected: string[] = [];
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
      rejected.push(
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
        rejected.push(`${l.record.title}: no quote (${String(err)})`);
      }
    }),
  );

  const byAgent = new Map(allowed.map((l) => [l.record.agent.toLowerCase(), l]));
  const quotes = (await liveQuotes(d.arkiv, task)).filter(
    (q) => q.record.skill === skill && byAgent.has(q.record.agent.toLowerCase()),
  );
  const best = quotes[0];
  if (!best) throw new Error(`No live ${skill} quote for ${task}`);
  const listing = byAgent.get(best.record.agent.toLowerCase());
  if (!listing) throw new Error("Quote from an unknown agent");
  d.log(
    `[${skill}] best quote: "${best.record.note}" — fee ${Number(best.record.priceUnits) / 1e6} USDC (${quotes.length} live)`,
  );

  const { response, paid } = await d.payingFetch(`${listing.record.endpoint}/work`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, trip, quoteKey: best.key }),
  });
  const body = (await response.json()) as { result?: unknown; error?: string; detail?: string };
  if (!response.ok || !paid) {
    throw new Error(
      `[${skill}] hire failed: HTTP ${response.status} ${body.error ?? ""} ${body.detail ?? ""}`,
    );
  }
  const hederaTx = paid.settlement.transaction;
  d.log(`[${skill}] paid ${Number(best.record.priceUnits) / 1e6} USDC via mandate → ${hederaTx}`);

  const buyer = d.buyerWriter.account.address;
  const job = await openJob(d.buyerWriter, {
    task,
    buyer,
    seller: best.record.agent,
    quote: best.key,
    status: "paid",
    mandateId: d.mandateId,
    description: `${skill} for ${trip.destinationName}`,
  });
  await recordReceipt(d.platformWriter, {
    job: job.entityKey,
    task,
    mandateId: d.mandateId,
    payer: d.payer,
    payTo: paid.requirements.payTo,
    amountUnits: best.record.priceUnits,
    hederaTx,
  });
  await rateAgent(d.buyerWriter, {
    agent: best.record.agent,
    job: job.entityKey,
    rater: buyer,
    score: 5,
    comment: "Delivered as quoted",
  });

  return {
    skill,
    agent: best.record.agent,
    quoteNote: best.record.note,
    feeUnits: best.record.priceUnits,
    hederaTx,
    jobKey: job.entityKey,
    result: body.result,
    rejected,
  };
}
