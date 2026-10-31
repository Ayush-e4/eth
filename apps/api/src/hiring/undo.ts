import { cancelMessage, HttpFacilitator } from "@eth/x402";
import { and, eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { scheduledPayments as table } from "../db/schema";
import type { HiringEnv } from "./env";

export interface Scheduled {
  scheduleId: string;
  executesAt: number; // ms
}

type Status = "scheduled" | "executed" | "cancelled" | "failed";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Undo windows for "Auto" chats: the concierge pays with an undo window, the facilitator
 * schedules the payment on Hedera, and until it runs the user can cancel it from the chat.
 * Only this chat's own payments can be cancelled, and the cancel is signed by the concierge
 * (the mandate's agent), which the facilitator checks on-chain. Payments are kept in the
 * database; when the facilitator has forgotten one (it restarted), Hedera's own record answers.
 */
export function undoWindows(
  db: Db,
  env: HiringEnv,
  seconds: number,
  d: {
    facilitator?: Pick<HttpFacilitator, "scheduled" | "cancelScheduled">;
    wait?: (ms: number) => Promise<void>;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const facilitator =
    d.facilitator ?? new HttpFacilitator(process.env.FACILITATOR_URL ?? "http://localhost:8402");
  const wait = d.wait ?? sleep;
  const fetchImpl = d.fetchImpl ?? fetch;
  const concierge = privateKeyToAccount(env.concierge.key);
  const mine = async (chatId: string, scheduleId: string) =>
    (
      await db
        .select()
        .from(table)
        .where(and(eq(table.scheduleId, scheduleId), eq(table.chatId, chatId)))
    )[0] ?? null;
  const settle = (scheduleId: string, status: Status) =>
    db.update(table).set({ status }).where(eq(table.scheduleId, scheduleId));

  /** Hedera's answer (the mirror node): deleted, ran, or still waiting. */
  async function onHedera(scheduleId: string): Promise<Status | null> {
    const res = await fetchImpl(`${env.mirrorUrl}/api/v1/schedules/${scheduleId}`).catch(
      () => null,
    );
    if (!res?.ok) return null;
    const s = (await res.json()) as { deleted?: boolean; executed_timestamp?: string | null };
    return s.deleted ? "cancelled" : s.executed_timestamp ? "executed" : "scheduled";
  }

  const cancelSigned = async (scheduleId: string) =>
    facilitator.cancelScheduled(
      scheduleId,
      await concierge.signMessage({ message: cancelMessage(scheduleId) }),
    );

  return {
    seconds,

    /** A payment was just signed: find its schedule (the facilitator makes it) and report it. */
    async watch(chatId: string, key: string, onScheduled: (s: Scheduled) => void) {
      for (let i = 0; i < 60; i++) {
        const s = await facilitator.scheduled(key).catch(() => null);
        if (s) {
          await db.insert(table).values({
            scheduleId: s.scheduleId,
            chatId,
            paymentKey: key,
            executesAt: new Date(s.executesAt),
          });
          onScheduled({ scheduleId: s.scheduleId, executesAt: s.executesAt });
          return;
        }
        await wait(1000);
      }
    },

    async status(chatId: string, scheduleId: string) {
      const p = await mine(chatId, scheduleId);
      if (!p) return null;
      let status = p.status as Status;
      if (status === "scheduled") {
        const live = await facilitator.scheduled(p.paymentKey).catch(() => null);
        status = live?.status ?? (await onHedera(scheduleId)) ?? "scheduled";
        if (status !== "scheduled") await settle(scheduleId, status);
      }
      return { scheduleId, executesAt: p.executesAt.getTime(), status };
    },

    async cancel(chatId: string, scheduleId: string) {
      const p = await mine(chatId, scheduleId);
      if (!p) return { ok: false, reason: "no such payment in this chat" };
      const out = await cancelSigned(scheduleId);
      if (out.ok) await settle(scheduleId, "cancelled");
      return out;
    },
  };
}

export type UndoWindows = ReturnType<typeof undoWindows>;
