import { fetchInrRates, type InrRates, readBids } from "@eth/agents/hiring";
import { arkivReader, arkivWriter, claimTask, postTask, setTaskStatus } from "@eth/arkiv";
import type { Card } from "@eth/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { openTasks } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { PER_PAYMENT_CAP } from "../hiring/mandates";
import type { ChatLike, HiringService } from "../hiring/service";

type TaskCard = Extract<Card, { type: "task" }>;

const RATES_MS = 60_000;
const BIDS_MS = 8_000; // card polls and the concierge share one Arkiv read per task

/**
 * Open tasks: instead of asking the agents we know, the concierge posts the job on Arkiv and any
 * agent with the skill bids by itself (a signed, expiring quote for that task). Bids get the same
 * short refs as quotes, so hiring, limits and approvals work unchanged; the award is then recorded
 * on Arkiv as a read-only claim.
 */
export function openTaskService(
  db: Db,
  env: HiringEnv,
  hiring: HiringService,
  arkiv = { reader: arkivReader(), writer: arkivWriter(env.concierge.key) },
) {
  // What we posted lives in the database (a restart keeps it); bid reads are only cached here.
  const mine = async (chatId: string, task: string) =>
    (
      await db
        .select()
        .from(openTasks)
        .where(and(eq(openTasks.task, task), eq(openTasks.chatId, chatId)))
    )[0] ?? null;
  const reads = new Map<string, { at: number; round: ReturnType<typeof readBids> }>();
  let rates: { at: number; value: Promise<InrRates> } | null = null;
  const inrRates = () => {
    if (!rates || Date.now() - rates.at > RATES_MS)
      rates = { at: Date.now(), value: fetchInrRates() };
    return rates.value;
  };

  return {
    async post(
      chat: ChatLike,
      job: { skill: string; title: string; input: Record<string, unknown>; minutes: number },
    ): Promise<TaskCard> {
      const task = `open-${chat.id.slice(0, 8)}-${Date.now().toString(36)}`;
      const minutes = Math.min(30, Math.max(2, Math.round(job.minutes)));
      const { entityKey } = await postTask(
        arkiv.writer,
        {
          task,
          poster: env.concierge.evm,
          skill: job.skill,
          title: job.title,
          input: job.input,
          maxFeeUnits: PER_PAYMENT_CAP,
          status: "open",
        },
        minutes * 60,
      );
      const closesAt = Date.now() + minutes * 60_000;
      await db.insert(openTasks).values({
        task,
        chatId: chat.id,
        entityKey,
        skill: job.skill,
        input: job.input,
        closesAt: new Date(closesAt),
      });
      return {
        type: "task",
        task,
        entityKey,
        skill: job.skill,
        title: job.title,
        maxFeeUnits: PER_PAYMENT_CAP.toString(),
        closesAt: new Date(closesAt).toISOString(),
      };
    },

    /** The bids so far, ranked, each held under a ref the concierge can hire. Null if not ours. */
    async bids(chatId: string, task: string) {
      const p = await mine(chatId, task);
      if (!p) return null;
      let read = reads.get(task);
      if (!read || Date.now() - read.at > BIDS_MS) {
        read = {
          at: Date.now(),
          round: inrRates().then((rates) =>
            readBids(p.skill, task, p.input, {
              arkiv: arkiv.reader,
              evm: env.mc.publicClient,
              registry: env.registry,
              inrRates: rates,
              log: () => {},
            }),
          ),
        };
        reads.set(task, read);
        read.round.catch(() => reads.delete(task)); // don't keep serving a failed read
      }
      const round = await read.round;
      const status = p.awarded ? "awarded" : Date.now() > p.closesAt.getTime() ? "closed" : "open";
      return {
        status,
        closesAt: p.closesAt.toISOString(),
        round,
        refs: await hiring.hold(chatId, round),
      };
    },

    /** After a hire: if what was hired was a bid on our open task, record the award on Arkiv. */
    async award(
      chatId: string,
      h: { round: { task: string }; option: { key: string; agent: `0x${string}` } },
    ) {
      // Only the first award of a task gets the row back (a task is awarded once).
      const [p] = await db
        .update(openTasks)
        .set({ awarded: true })
        .where(
          and(
            eq(openTasks.task, h.round.task),
            eq(openTasks.chatId, chatId),
            eq(openTasks.awarded, false),
          ),
        )
        .returning();
      if (!p) return;
      await claimTask(arkiv.writer, {
        task: h.round.task,
        poster: env.concierge.evm,
        quote: h.option.key as `0x${string}`,
        agent: h.option.agent,
      });
      await setTaskStatus(arkiv.writer, p.entityKey as `0x${string}`, "awarded");
    },
  };
}

export type OpenTaskService = ReturnType<typeof openTaskService>;
