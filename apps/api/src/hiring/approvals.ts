import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals } from "../db/schema";

type Approval = typeof approvals.$inferSelect;

const HUMAN_FRESH_MS = 5 * 60_000; // a human check unlocks its payment for 5 minutes

/**
 * "Ask first" approvals: one code per payment the concierge wants to make. With `requireHuman`,
 * an approval counts only after a World ID check for it passed, within 5 minutes. One approval
 * pays once. Kept in the database, so a restart doesn't lose a card the user is answering.
 */
export function approvalBook(db: Db, requireHuman = false) {
  const human = (a: Approval) =>
    !requireHuman || (!!a.humanAt && Date.now() - a.humanAt.getTime() < HUMAN_FRESH_MS);
  const one = (chatId: string, code: string) =>
    and(eq(approvals.chatId, chatId), eq(approvals.code, code));
  const get = async (chatId: string, code: string) =>
    (await db.select().from(approvals).where(one(chatId, code)))[0] ?? null;

  return {
    requireHuman,

    /** Takes (uses up) an approval for this offer, if the user gave one. */
    async take(chatId: string, ref: string, agent: string, feeUnits: bigint) {
      const mine = await db.select().from(approvals).where(eq(approvals.chatId, chatId));
      // A quote can lapse during a slow human check; the approval was for this agent and fee.
      const same = (a: Approval) => a.ref === ref || (a.agent === agent && feeUnits <= a.feeUnits);
      const ok = mine.find((a) => same(a) && a.approved && human(a));
      if (!ok) return false;
      // Only one caller gets the row back, so an approval can't pay twice.
      const gone = await db.delete(approvals).where(one(chatId, ok.code)).returning();
      return gone.length === 1;
    },

    /** Asks for one: returns the code the card shows. */
    async ask(chatId: string, ref: string, agent: string, feeUnits: bigint) {
      const code = randomBytes(3).toString("hex");
      await db.insert(approvals).values({ chatId, code, ref, agent, feeUnits });
      return code;
    },

    async pending(chatId: string, code: string) {
      const a = await get(chatId, code);
      return !!a && !a.approved;
    },

    async markHuman(chatId: string, code: string) {
      await db.update(approvals).set({ humanAt: new Date() }).where(one(chatId, code));
    },

    /** Reads "Approve abc123" / "Decline abc123" in what the user sent. */
    async note(chatId: string, text: string) {
      for (const m of text.matchAll(/\b(approve|decline)\s+([a-z0-9]{6})\b/gi)) {
        const code = (m[2] ?? "").toLowerCase();
        const entry = await get(chatId, code);
        if (!entry) continue;
        // "Approve" only counts once the human check passed; "Decline" always counts.
        const approved = (m[1] ?? "").toLowerCase() === "approve" && human(entry);
        await db.update(approvals).set({ approved }).where(one(chatId, code));
      }
    },
  };
}
