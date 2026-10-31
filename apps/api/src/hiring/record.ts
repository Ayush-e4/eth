import type { Hire } from "@eth/agents/hiring";
import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import type { Address } from "viem";
import type { Db } from "../db/client";
import { hires } from "../db/schema";
import { recordSubHires } from "./delegate";
import type { HiringEnv } from "./env";
import type { Reputation } from "./reputation";

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
  const [row] = await db
    .insert(hires)
    .values({ ...h, registry: env.registry.toLowerCase() })
    .returning({ id: hires.id });
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

/** A slice of the chat's limit granted to an agent that hires others (see delegate.ts). */
export interface Granted {
  mandateId: string;
  payer: string;
  budget: bigint;
  payees: Address[];
}

/**
 * Everything after an agent delivered: save the hire (and its log entry), record any agents it
 * hired itself, review it on ERC-8004, and build the card the chat shows.
 */
export async function finishHire(
  db: Db,
  env: HiringEnv,
  h: {
    chatId: string;
    mandateId: bigint;
    hire: Hire;
    delegation?: Granted;
    reputation?: Reputation;
  },
): Promise<Extract<Card, { type: "hired" }>> {
  const { hire, delegation } = h;
  // The payer reviews the agent on its ERC-8004 identity, in the background.
  void h.reputation?.rate(hire.agent, hire.skill, hire.endpoint);
  const log = await saveHire(db, env, {
    chatId: h.chatId,
    mandateId: h.mandateId,
    skill: hire.skill,
    agent: hire.agent,
    title: hire.agentTitle,
    feeUnits: hire.feeUnits,
    hederaTx: hire.hederaTx,
    jobKey: hire.jobKey,
    result: hire.result,
  });
  const subHires = delegation
    ? await recordSubHires(db, env, h.chatId, delegation, hire.result)
    : undefined;
  return {
    type: "hired",
    skill: hire.skill,
    title: hire.agentTitle.split(" — ")[0] ?? hire.agentTitle,
    summary: hire.quoteNote,
    feeUnits: hire.feeUnits.toString(),
    hederaTx: hire.hederaTx,
    jobKey: hire.jobKey,
    log,
    subMandateId: delegation?.mandateId,
    subHires,
  };
}
