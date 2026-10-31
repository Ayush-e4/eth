import { and, eq, inArray } from "drizzle-orm";
import type { Hex } from "viem";
import type { Db } from "../db/client";
import { escrowReviews as table } from "../db/schema";
import type { EscrowBuyer } from "./env";

export type ReviewStatus =
  | "holding"
  | "releasing"
  | "released"
  | "disputing"
  | "disputed"
  | "refunded"
  | "failed";

const short = (err: unknown) => String(err).slice(0, 200);

/**
 * Pay on delivery, the user's side. When an agent delivers, its fee stays held for a review
 * window (ESCROW_REVIEW_SECONDS, default 2 min). In it the user can pay now or dispute; when it
 * ends, the concierge pays the agent. A dispute freezes the fee on-chain: the agent refunds it
 * (ours do), or the user pays anyway. Web2 analogy: "confirm receipt" on a marketplace order.
 * Each change is claimed with one conditional UPDATE, so a click and the timer can't both act.
 */
export function escrowReviews(
  db: Db,
  buyer: EscrowBuyer,
  seconds: number,
  /** Told when a fee starts waiting for the user's review (to nudge them). */
  onHold?: (chatId: string, title: string, releaseAt: Date) => void,
) {
  const timers = new Map<string, NodeJS.Timeout>();

  const arm = (escrowId: string, at: Date) => {
    clearTimeout(timers.get(escrowId));
    const t = setTimeout(
      () => void release(escrowId).catch(() => {}),
      Math.max(0, at.getTime() - Date.now()),
    );
    t.unref?.();
    timers.set(escrowId, t);
  };

  /** Moves the row from one of `from` to `to`; false if someone else got there first. */
  const claim = async (escrowId: string, from: ReviewStatus[], to: ReviewStatus) =>
    (
      await db
        .update(table)
        .set({ status: to })
        .where(and(eq(table.escrowId, escrowId), inArray(table.status, from)))
        .returning({ id: table.escrowId })
    ).length === 1;

  const set = (escrowId: string, v: Partial<typeof table.$inferInsert>) =>
    db.update(table).set(v).where(eq(table.escrowId, escrowId));

  async function release(escrowId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!(await claim(escrowId, ["holding", "disputed"], "releasing")))
      return { ok: false, reason: "it's no longer waiting to be paid" };
    clearTimeout(timers.get(escrowId));
    try {
      const tx = await buyer.release(escrowId as Hex);
      await set(escrowId, { status: "released", releasedTx: tx });
      return { ok: true };
    } catch (err) {
      // Maybe it's settled already (the agent refunded or claimed it): the chain says.
      const state = await buyer.read(escrowId as Hex).then(
        (e) => e.state,
        () => null,
      );
      await set(escrowId, {
        status: state === "released" || state === "refunded" ? state : "failed",
        error: short(err),
      });
      return { ok: false, reason: `couldn't pay it out: ${short(err)}` };
    }
  }

  return {
    seconds,

    /** An agent delivered: hold its fee for the review window. Returns when it pays out. */
    async hold(chatId: string, escrowId: string, title: string): Promise<Date> {
      const releaseAt = new Date(Date.now() + seconds * 1000);
      await db.insert(table).values({ escrowId, chatId, title, releaseAt }).onConflictDoNothing();
      arm(escrowId, releaseAt);
      onHold?.(chatId, title, releaseAt);
      return releaseAt;
    },

    release,

    /** The user objects: freeze the fee on-chain until the agent refunds or the user pays. */
    async dispute(escrowId: string): Promise<{ ok: boolean; reason?: string }> {
      if (!(await claim(escrowId, ["holding"], "disputing")))
        return { ok: false, reason: "it's no longer waiting to be paid" };
      clearTimeout(timers.get(escrowId));
      try {
        await buyer.dispute(escrowId as Hex);
        await set(escrowId, { status: "disputed" });
        return { ok: true };
      } catch (err) {
        // Not disputed (e.g. the agent never marked it delivered): back to waiting.
        const [row] = await db.select().from(table).where(eq(table.escrowId, escrowId));
        await set(escrowId, { status: "holding", error: short(err) });
        if (row) arm(escrowId, row.releaseAt);
        return { ok: false, reason: `couldn't dispute it: ${short(err)}` };
      }
    },

    /** How a chat's held fee stands, here and on-chain. Null if it isn't this chat's. */
    async status(chatId: string, escrowId: string) {
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.escrowId, escrowId), eq(table.chatId, chatId)));
      if (!row) return null;
      const onChain = await buyer.read(escrowId as Hex).then(
        (e) => e.state,
        () => null,
      );
      return {
        status: row.status as ReviewStatus,
        releaseAt: row.releaseAt.toISOString(),
        releasedTx: row.releasedTx,
        onChain, // held | delivered | disputed | released | refunded
      };
    },

    /**
     * After a restart: a click cut off mid-way is settled by the chain (a dispute that went
     * through stays disputed, never paid out by the timer), then waiting fees get their timers
     * back (overdue ones pay out now).
     */
    async resume() {
      const cut = await db
        .select()
        .from(table)
        .where(inArray(table.status, ["releasing", "disputing"]));
      for (const r of cut) {
        const state = await buyer.read(r.escrowId as Hex).then(
          (e) => e.state,
          () => null,
        );
        const status =
          state === "disputed" ? "disputed" : state === "released" ? "released" : "holding";
        await set(r.escrowId, { status });
      }
      const rows = await db.select().from(table).where(eq(table.status, "holding"));
      for (const r of rows) arm(r.escrowId, r.releaseAt);
      return rows.length;
    },
  };
}

export type EscrowReviews = ReturnType<typeof escrowReviews>;
