import { cancelMessage, HttpFacilitator } from "@eth/x402";
import { privateKeyToAccount } from "viem/accounts";
import type { HiringEnv } from "./env";

export interface Scheduled {
  scheduleId: string;
  executesAt: number; // ms
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Undo windows for "Auto" chats: the concierge pays with an undo window, the facilitator
 * schedules the payment on Hedera, and until it runs the user can cancel it from the chat.
 * Only this chat's own payments can be cancelled, and the cancel is signed by the concierge
 * (the mandate's agent), which the facilitator checks on-chain.
 */
export function undoWindows(
  env: HiringEnv,
  seconds: number,
  facilitator = new HttpFacilitator(process.env.FACILITATOR_URL ?? "http://localhost:8402"),
  wait: (ms: number) => Promise<void> = sleep,
) {
  const mine = new Map<string, { chatId: string; key: string }>(); // scheduleId → owner
  const concierge = privateKeyToAccount(env.concierge.key);

  return {
    seconds,

    /** A payment was just signed: find its schedule (the facilitator makes it) and report it. */
    async watch(chatId: string, key: string, onScheduled: (s: Scheduled) => void) {
      for (let i = 0; i < 60; i++) {
        const s = await facilitator.scheduled(key).catch(() => null);
        if (s) {
          mine.set(s.scheduleId, { chatId, key });
          onScheduled({ scheduleId: s.scheduleId, executesAt: s.executesAt });
          return;
        }
        await wait(1000);
      }
    },

    async status(chatId: string, scheduleId: string) {
      const p = mine.get(scheduleId);
      if (!p || p.chatId !== chatId) return null;
      return facilitator.scheduled(p.key);
    },

    async cancel(chatId: string, scheduleId: string) {
      const p = mine.get(scheduleId);
      if (!p || p.chatId !== chatId) return { ok: false, reason: "no such payment in this chat" };
      const signature = await concierge.signMessage({ message: cancelMessage(scheduleId) });
      return facilitator.cancelScheduled(scheduleId, signature);
    },
  };
}

export type UndoWindows = ReturnType<typeof undoWindows>;
