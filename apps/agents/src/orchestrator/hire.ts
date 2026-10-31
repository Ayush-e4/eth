import { type ArkivReader, type ArkivWriter, openJob, rateAgent, recordReceipt } from "@eth/arkiv";
import type { Delegation } from "@eth/shared";
import type { PaidResponse } from "@eth/x402";
import type { Hex, LocalAccount, PublicClient } from "viem";
import { signedHeaders } from "../auth";
import type { Trip } from "../trip";
import { awaitJob, HireFailed, HirePending, readJob } from "./job-client";
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
  jobWaitMs?: number; // how long to wait on an agent that's still working (default 2 min)
  /** Pay on delivery: the buyer pays the held fee out once it has the result. Without it, the
   *  agent claims it after the review window. Returns the Hedera transaction id. */
  release?: (escrowId: Hex) => Promise<string>;
}

/** A fee paid on delivery: held, marked delivered by the agent, then released by us. */
export interface HireEscrow {
  id: Hex;
  deliveredTx?: string;
  releasedTx?: string;
  releaseFailed?: string; // then the agent can claim it after its review window
}

export interface Hire {
  skill: string;
  agent: `0x${string}`;
  agentTitle: string;
  endpoint: string; // the agent's service, for follow-ups (e.g. managing the booking)
  quoteNote: string;
  feeUnits: bigint;
  itemTotal?: number;
  itemCurrency?: string;
  choice: string; // why this quote won
  hederaTx: string;
  jobKey: `0x${string}`;
  result: unknown;
  rejected: string[]; // why other candidates lost or were skipped
  escrow?: HireEscrow;
}

/**
 * Autopilot: hire the best agent for one skill — collect quotes, take the lowest total cost,
 * pay and record. The agentic orchestrator uses the same two steps but lets Claude choose.
 */
export async function hire(skill: string, task: string, trip: Trip, d: HireDeps): Promise<Hire> {
  const round = await collectQuotes(skill, task, trip, d);
  const best = round.options[0];
  if (!best) throw new Error(`No live ${skill} quote for ${task}`);
  return buy(round, best, `${skill} for ${trip.destinationName}`, d, round.bestReason);
}

/** What came back from a paid job: the result, and where the payment is on Hedera. */
export interface Delivered {
  result: unknown;
  hederaTx: string;
  payTo: string; // the agent's Hedera account
  escrow?: { id: Hex; deliveredTx?: string }; // paid on delivery: still to release
}

const failure = (skill: string, status: number | string, body: WorkReply) => {
  const refund = body.refund?.transaction
    ? ` — fee refunded: ${body.refund.transaction}`
    : body.refund?.failed
      ? ` — refund failed: ${body.refund.failed}`
      : "";
  return new HireFailed(
    `[${skill}] hire failed: HTTP ${status} ${body.error ?? ""} ${body.detail ?? ""}${refund}`,
  );
};

/**
 * Pay the chosen agent's /work endpoint over x402, then record job, receipt and rating on Arkiv.
 * /work is signed by our buyer key, so if the answer is "still working" (or the call breaks after
 * paying) we read the job back instead of paying again; if it outlasts `jobWaitMs`, HirePending
 * says where to read it later.
 */
export async function buy(
  round: QuoteRound,
  pick: QuoteOption,
  label: string, // what the job is for, e.g. "hotels for Goa" (public, on Arkiv)
  d: HireDeps,
  choice: string,
  delegation?: Delegation, // a sub-mandate for an agent that hires others (see TripMint)
): Promise<Hire> {
  const { skill, task } = round;
  d.log(`[${skill}] hiring ${pick.title}: "${pick.note}"`);
  d.log(`[${skill}] because: ${choice}`);
  const url = `${pick.endpoint}/work`;
  const body = JSON.stringify({ task, skill, input: round.input, quoteKey: pick.key, delegation });
  const signer = d.buyerWriter.account as LocalAccount;
  const signed = await signedHeaders(signer, "POST", new URL(url).pathname, body);
  const later = async (broke?: unknown): Promise<Delivered> => {
    if (broke) {
      // The call broke. No job at the agent → nothing was paid; agent unreachable → can't tell.
      const first = await readJob(pick.endpoint, pick.key, signer).catch(() => undefined);
      if (first === null) throw broke;
      if (first === undefined) throw new HirePending(pick.endpoint, pick.key, null);
    }
    const view = await awaitJob(pick.endpoint, pick.key, signer, { timeoutMs: d.jobWaitMs });
    if (view?.status === "delivered")
      return {
        result: view.result,
        hederaTx: view.paymentTx ?? "",
        payTo: view.payTo,
        ...(view.escrow ? { escrow: view.escrow } : {}),
      };
    if (view?.status === "failed") throw failure(skill, "job failed", view);
    throw new HirePending(pick.endpoint, pick.key, view);
  };

  let done: Delivered;
  try {
    const { response, paid } = await d.payingFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed },
      body,
    });
    const reply = await readJson(response);
    if (response.status === 202) done = await later();
    else if (!response.ok || !paid) throw failure(skill, response.status, reply);
    else
      done = {
        result: reply.result,
        hederaTx: paid.settlement.transaction,
        payTo: paid.requirements.payTo,
        ...(paid.escrowId ? { escrow: reply.escrow ?? { id: paid.escrowId } } : {}),
      };
  } catch (err) {
    if (err instanceof HirePending || err instanceof HireFailed) throw err;
    done = await later(err); // the call broke: we may have paid, so ask the agent
  }
  d.log(`[${skill}] paid ${Number(pick.feeUnits) / 1e6} USDC via mandate → ${done.hederaTx}`);
  return recordHire(round, pick, label, d, choice, done);
}

/** The public records of a paid, delivered hire (also used when a hire is read back later). */
export async function recordHire(
  round: QuoteRound,
  pick: QuoteOption,
  label: string,
  d: Pick<HireDeps, "buyerWriter" | "platformWriter" | "mandateId" | "payer" | "log" | "release">,
  choice: string,
  done: Delivered,
): Promise<Hire> {
  const { skill, task } = round;
  const { hederaTx } = done;
  const escrow = done.escrow && (await releaseEscrow(done.escrow, d, skill));

  // From here the agent is paid and the job done. The public records below must never lose that:
  // if Arkiv refuses one, log it and still return the hire (the payment is proof on Hedera).
  const buyer = d.buyerWriter.account.address;
  const record = async <T>(what: string, write: () => Promise<T>) =>
    write().catch((err: unknown) => {
      d.log(`[${skill}] couldn't record the ${what} on Arkiv: ${String(err).slice(0, 200)}`);
      return null;
    });
  const job = await record("job", () =>
    openJob(d.buyerWriter, {
      task,
      buyer,
      seller: pick.agent,
      quote: pick.key,
      status: "paid",
      mandateId: d.mandateId,
      description: `${label}: ${choice}`.slice(0, 1000),
    }),
  );
  if (job) {
    await record("receipt", () =>
      recordReceipt(d.platformWriter, {
        job: job.entityKey,
        task,
        mandateId: d.mandateId,
        payer: d.payer,
        payTo: done.payTo,
        amountUnits: pick.feeUnits,
        hederaTx,
      }),
    );
    await record("rating", () =>
      rateAgent(d.buyerWriter, {
        agent: pick.agent,
        job: job.entityKey,
        rater: buyer,
        score: 5,
        comment: "Delivered as quoted",
      }),
    );
  }

  return {
    skill,
    agent: pick.agent,
    agentTitle: pick.title,
    endpoint: pick.endpoint,
    quoteNote: pick.note,
    feeUnits: pick.feeUnits,
    itemTotal: pick.itemTotal,
    itemCurrency: pick.itemCurrency,
    choice,
    hederaTx,
    jobKey: job?.entityKey ?? "0x", // "0x": paid, but Arkiv didn't take the job record
    result: done.result,
    rejected: otherOptions(round, pick.key),
    ...(escrow ? { escrow } : {}),
  };
}

/** We have the result: pay the held fee out to the agent. */
async function releaseEscrow(
  e: NonNullable<Delivered["escrow"]>,
  d: Pick<HireDeps, "release" | "log">,
  skill: string,
): Promise<HireEscrow> {
  if (!d.release) return { ...e, releaseFailed: "this buyer doesn't release; the agent claims it" };
  try {
    const releasedTx = await d.release(e.id);
    d.log(`[${skill}] released the escrowed fee → ${releasedTx}`);
    return { ...e, releasedTx };
  } catch (err) {
    d.log(`[${skill}] couldn't release the escrow: ${String(err).slice(0, 200)}`);
    return { ...e, releaseFailed: String(err).slice(0, 200) };
  }
}

interface WorkReply {
  result?: unknown;
  escrow?: { id: Hex; deliveredTx?: string };
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
