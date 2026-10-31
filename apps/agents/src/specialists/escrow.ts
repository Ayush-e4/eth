import { createHash } from "node:crypto";
import type { EscrowState } from "@eth/mandates";
import { encodeJson } from "@eth/shared";
import type { EscrowTerms } from "@eth/x402";
import type { Hex } from "viem";
import type { Job, JobStore, Refund } from "./jobs";

/**
 * Pay on delivery, the agent's side. The buyer's fee waits in MandateRegistry: the agent marks
 * the job delivered (with a hash of the result) and the buyer releases it, or after the review
 * window the agent claims it. If the job fails, the agent refunds it from the registry, which
 * also gives the buyer's limit its budget back. Web2 analogy: an escrow service, run by code.
 */
export interface EscrowMoves {
  terms: EscrowTerms;
  deliver(id: Hex, resultHash: Hex): Promise<string>; // each returns the Hedera transaction id
  refund(id: Hex): Promise<string>;
  claim(id: Hex): Promise<string>;
  read(id: Hex): Promise<{ state: EscrowState; deliveredAt: bigint; reviewSeconds: number }>;
}

/** What the agent keeps about one escrowed fee. */
export interface JobEscrow {
  id: Hex; // escrowIdOf(mandateId, nonce)
  deliveredTx?: string;
  claimTx?: string;
  /** How it ended for the agent: paid out (released or claimed) or sent back. */
  closed?: "paid" | "refunded";
}

/** The hash of a result, as the delivery record on Arkiv and the escrow both show it. */
export const resultHash = (result: unknown): Hex =>
  `0x${createHash("sha256")
    .update(JSON.stringify(encodeJson(result ?? null)))
    .digest("hex")}`;

const short = (err: unknown) => String(err).slice(0, 200);

export function escrowJobs(
  moves: EscrowMoves | undefined,
  jobs: JobStore,
  log: (line: string) => void,
) {
  const update = (j: Job, e: Partial<JobEscrow>) =>
    j.escrow && jobs.update(j.quoteKey, { escrow: { ...j.escrow, ...e } });

  async function delivered(j: Job) {
    if (!moves || !j.escrow || j.escrow.deliveredTx) return;
    try {
      update(j, { deliveredTx: await moves.deliver(j.escrow.id, resultHash(j.result)) });
    } catch (err) {
      log(`${j.task}: couldn't mark the escrow delivered (will retry): ${short(err)}`);
    }
  }

  async function refund(j: Job): Promise<Refund> {
    if (!moves || !j.escrow) return { failed: "no escrow to refund" };
    try {
      const transaction = await moves.refund(j.escrow.id);
      update(j, { closed: "refunded" });
      return { transaction };
    } catch (err) {
      return { failed: short(err) };
    }
  }

  /**
   * Every minute: deliveries that weren't marked (we crashed) and refunds that failed are tried
   * again, disputed fees are refunded, and fees the buyer left unreleased past its review window
   * are claimed.
   */
  async function sweep(now = Date.now()) {
    if (!moves) return;
    for (const j of jobs.openEscrows()) {
      const e = j.escrow as JobEscrow;
      if (j.status === "delivered" && !e.deliveredTx) {
        await delivered(j);
        continue;
      }
      const onChain = await moves.read(e.id).catch(() => null);
      if (!onChain) continue;
      if (onChain.state === "released") update(j, { closed: "paid" });
      else if (onChain.state === "refunded") update(j, { closed: "refunded" });
      else if (j.status === "failed" || onChain.state === "disputed") {
        // Failed, or the buyer disputed what we delivered: our policy is to give the fee back.
        const r = await refund(j);
        if ("transaction" in r) jobs.update(j.quoteKey, { refund: r });
        if (onChain.state === "disputed")
          log(
            `${j.task}: the buyer disputed it; refunded (${"transaction" in r ? r.transaction : r.failed})`,
          );
      } else if (
        onChain.state === "delivered" &&
        now / 1000 >= Number(onChain.deliveredAt) + onChain.reviewSeconds
      ) {
        try {
          update(j, { claimTx: await moves.claim(e.id), closed: "paid" });
          log(`${j.task}: the buyer didn't release it in time; claimed the fee`);
        } catch (err) {
          log(`${j.task}: claim failed: ${short(err)}`);
        }
      }
    }
  }

  return { delivered, refund, sweep };
}
