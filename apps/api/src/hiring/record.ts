import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { hires } from "../db/schema";
import type { HiringEnv } from "./env";

export interface PaidHire {
  chatId: string;
  mandateId: bigint;
  skill: string;
  agent: string;
  title: string;
  feeUnits: bigint;
  hederaTx: string;
  jobKey: string;
  result: unknown;
}

/**
 * Saves a paid hire, then writes it to the public spend log and remembers the entry's number.
 * Saved first, so a slow or failed log write can't lose a paid hire.
 */
export async function saveHire(
  db: Db,
  env: HiringEnv,
  h: PaidHire,
): Promise<{ topic: string; seq: number } | undefined> {
  const [row] = await db.insert(hires).values(h).returning({ id: hires.id });
  const seq =
    (await env.log?.write({
      kind: "agentnet.hired",
      mandateId: h.mandateId.toString(),
      skill: h.skill,
      agent: h.agent,
      fee: h.feeUnits.toString(),
      payment: h.hederaTx,
      job: h.jobKey,
    })) ?? null;
  if (seq === null || !env.log) return undefined;
  if (row)
    await db
      .update(hires)
      .set({ logSeq: seq })
      .where(eq(hires.id, row.id))
      .catch(() => {}); // the entry is on Hedera either way
  return { topic: env.log.topicId, seq };
}
