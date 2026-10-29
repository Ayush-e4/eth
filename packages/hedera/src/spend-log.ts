import type { Client } from "@hiero-ledger/sdk";
import { submitMessage } from "./hcs";

/**
 * The public spend log: one HCS topic where every agent payment (written by the facilitator,
 * kind "x402.settled") and every spending-limit change and hire (written by the app) is
 * appended. Anyone can read it from the mirror node; nobody can edit or delete an entry.
 */
export type SpendLogEvent =
  | {
      kind: "agentnet.mandate.created";
      mandateId: string;
      owner: string;
      budget: string;
      payees: string[];
      expiresAt: number;
      via: "demo" | "wallet";
    }
  | { kind: "agentnet.mandate.revoked"; mandateId: string; by: string }
  | {
      kind: "agentnet.mandate.delegated"; // a slice of a limit, for an agent that hires agents
      mandateId: string;
      parentId: string;
      agent: string;
      budget: string;
      payees: string[];
    }
  | {
      kind: "agentnet.hired";
      mandateId: string;
      skill: string;
      agent: string;
      fee: string;
      payment: string; // Hedera transaction id of the x402 payment
      job: string; // Arkiv entity key of the job record
    };

export interface SpendLog {
  topicId: string;
  /** Returns the entry's sequence number, or null if the write failed. */
  write(event: SpendLogEvent): Promise<number | null>;
}

/** Writes are best-effort: a log hiccup must never undo or block a payment that happened. */
export function spendLog(
  client: Client,
  topicId: string,
  submitKey: string,
  submit: typeof submitMessage = submitMessage,
): SpendLog {
  return {
    topicId,
    async write(event) {
      try {
        const { sequence } = await submit(client, {
          topicId,
          submitKey,
          message: { ...event, at: new Date().toISOString() },
        });
        return sequence;
      } catch (err) {
        console.error(`spend log: couldn't write ${event.kind}:`, err);
        return null;
      }
    },
  };
}
