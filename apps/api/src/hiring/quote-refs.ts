import type { QuoteOption, QuoteRound } from "@eth/agents/hiring";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { decodeJson, encodeJson } from "../db/json";
import { quoteRefs as table } from "../db/schema";

export interface Held {
  ref: string; // "q1": what the user and Claude use; quote keys are long
  round: QuoteRound;
  option: QuoteOption;
  at: number;
}

const QUOTE_TTL_MS = 170_000; // agents hold a quote for 3 minutes; stop a little earlier

/** Quotes kept under short refs for a few minutes, in the database so a restart keeps them. */
export function quoteRefs(db: Db) {
  const toHeld = (r: typeof table.$inferSelect): Held => ({
    ref: `q${r.n}`,
    round: decodeJson(r.round),
    option: decodeJson(r.option),
    at: r.heldAt.getTime(),
  });
  const fresh = () => gt(table.heldAt, new Date(Date.now() - QUOTE_TTL_MS));

  return {
    /** A chat's live quotes, oldest first. */
    async live(chatId: string): Promise<Held[]> {
      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.chatId, chatId), fresh()))
        .orderBy(asc(table.n));
      return rows.map(toHeld);
    },

    async find(chatId: string, ref: string): Promise<Held | null> {
      const n = Number(/^q(\d+)$/.exec(ref)?.[1]);
      if (!Number.isSafeInteger(n)) return null;
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.chatId, chatId), eq(table.n, n), fresh()));
      return row ? toHeld(row) : null;
    },

    /**
     * Keeps a round's offers under short refs (q1, q2…). An offer already held (an open task's
     * bids are read again and again) keeps its ref and its clock.
     */
    async hold(chatId: string, round: QuoteRound): Promise<Held[]> {
      const now = await this.live(chatId);
      const out: Held[] = [];
      for (const option of round.options) {
        const had = now.find((h) => h.option.key === option.key);
        if (had) {
          out.push(had);
          continue;
        }
        const [row] = await db
          .insert(table)
          .values({
            chatId,
            task: round.task,
            optionKey: option.key,
            round: encodeJson(round),
            option: encodeJson(option),
          })
          .returning();
        if (row) out.push(toHeld(row));
      }
      return out;
    },

    /** That job is done: its other offers can't be hired any more. */
    async drop(chatId: string, task: string) {
      await db.delete(table).where(and(eq(table.chatId, chatId), eq(table.task, task)));
    },
  };
}
