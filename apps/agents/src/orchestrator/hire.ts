import { type ArkivReader, type ArkivWriter, openJob, rateAgent, recordReceipt } from "@eth/arkiv";
import type { PaidResponse } from "@eth/x402";
import type { PublicClient } from "viem";
import type { Trip } from "../trip";
import type { InrRates } from "./procure";
import { collectQuotes, otherOptions, type QuoteOption, type QuoteRound } from "./quotes";

export interface HireDeps {
  arkiv: ArkivReader;
  buyerWriter: ArkivWriter; // orchestrator's own wallet (jobs, ratings)
  platformWriter: ArkivWriter; // trusted wallet that publishes receipts
  payingFetch: (url: string, init?: RequestInit) => Promise<PaidResponse>;
  evm: PublicClient; // Hedera JSON-RPC, to read the mandate
  registry: `0x${string}`;
  mandateId: bigint;
  payer: string; // mandate owner's Hedera account
  inrRates: InrRates; // to compare quotes in different currencies
  log: (line: string) => void;
}

export interface Hire {
  skill: string;
  agent: `0x${string}`;
  quoteNote: string;
  feeUnits: bigint;
  itemTotal?: number;
  itemCurrency?: string;
  choice: string; // why this quote won
  hederaTx: string;
  jobKey: `0x${string}`;
  result: unknown;
  rejected: string[]; // why other candidates lost or were skipped
}

/**
 * Autopilot: hire the best agent for one skill — collect quotes, take the lowest total cost,
 * pay and record. The agentic orchestrator uses the same two steps but lets Claude choose.
 */
export async function hire(skill: string, task: string, trip: Trip, d: HireDeps): Promise<Hire> {
  const round = await collectQuotes(skill, task, trip, d);
  const best = round.options[0];
  if (!best) throw new Error(`No live ${skill} quote for ${task}`);
  return buy(round, best, trip, d, round.bestReason);
}

/** Pay the chosen agent's /work endpoint over x402, then record job, receipt and rating on Arkiv. */
export async function buy(
  round: QuoteRound,
  pick: QuoteOption,
  trip: Trip,
  d: HireDeps,
  choice: string,
): Promise<Hire> {
  const { skill, task } = round;
  d.log(`[${skill}] hiring ${pick.title}: "${pick.note}"`);
  d.log(`[${skill}] because: ${choice}`);
  const { response, paid } = await d.payingFetch(`${pick.endpoint}/work`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, trip, quoteKey: pick.key }),
  });
  const body = await readJson(response);
  if (!response.ok || !paid) {
    const refund = body.refund?.transaction
      ? ` — fee refunded: ${body.refund.transaction}`
      : body.refund?.failed
        ? ` — refund failed: ${body.refund.failed}`
        : "";
    throw new Error(
      `[${skill}] hire failed: HTTP ${response.status} ${body.error ?? ""} ${body.detail ?? ""}${refund}`,
    );
  }
  const hederaTx = paid.settlement.transaction;
  d.log(`[${skill}] paid ${Number(pick.feeUnits) / 1e6} USDC via mandate → ${hederaTx}`);

  const buyer = d.buyerWriter.account.address;
  const job = await openJob(d.buyerWriter, {
    task,
    buyer,
    seller: pick.agent,
    quote: pick.key,
    status: "paid",
    mandateId: d.mandateId,
    description: `${skill} for ${trip.destinationName}: ${choice}`.slice(0, 1000),
  });
  await recordReceipt(d.platformWriter, {
    job: job.entityKey,
    task,
    mandateId: d.mandateId,
    payer: d.payer,
    payTo: paid.requirements.payTo,
    amountUnits: pick.feeUnits,
    hederaTx,
  });
  await rateAgent(d.buyerWriter, {
    agent: pick.agent,
    job: job.entityKey,
    rater: buyer,
    score: 5,
    comment: "Delivered as quoted",
  });

  return {
    skill,
    agent: pick.agent,
    quoteNote: pick.note,
    feeUnits: pick.feeUnits,
    itemTotal: pick.itemTotal,
    itemCurrency: pick.itemCurrency,
    choice,
    hederaTx,
    jobKey: job.entityKey,
    result: body.result,
    rejected: otherOptions(round, pick.key),
  };
}

interface WorkReply {
  result?: unknown;
  error?: string;
  detail?: string;
  refund?: { transaction?: string; failed?: string };
}

/** Agents are third parties: a failed reply may not even be JSON. */
async function readJson(res: Response): Promise<WorkReply> {
  const text = await res.text();
  try {
    return JSON.parse(text) as WorkReply;
  } catch {
    return { error: "non_json_reply", detail: text.slice(0, 200) };
  }
}
