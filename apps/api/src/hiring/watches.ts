import { type Hire, signedHeaders } from "@eth/agents/hiring";
import type { Card } from "@eth/shared";
import { and, eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { chats, messages, fareWatches as table } from "../db/schema";
import type { HiringEnv } from "./env";
import type { HiringService } from "./service";

/** A watch as FareWatch reports it (see apps/agents/src/specialists/farewatch.ts). */
export interface WatchView {
  input: {
    origin: string;
    destination: string;
    date: string;
    adults: number;
    targetInr?: number;
    autoBook?: boolean;
  };
  until: string;
  status: "watching" | "ended" | "stopped";
  baseline: Check;
  lowest: Check;
  checks: Check[];
  alerts: (Check & { was: number; reason: string })[];
}
type Check = { at: string; price: number; flight: string; simulated?: boolean };

const EVERY_MS = 60_000;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const addDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Fare watches the user hired: the API reads each back from FareWatch (signed by the concierge,
 * its buyer) every minute, posts each new alert in the chat with a "Book it" choice, and, if
 * the user asked (a target, auto-book, an "Auto" chat), books the cheapest fare at or under
 * the target through the normal hire, with its limit, approvals, undo window and escrow.
 */
export function fareWatchFollower(
  db: Db,
  env: HiringEnv,
  d: { hiring?: () => HiringService | null; fetchImpl?: typeof fetch; simulate?: boolean } = {},
) {
  const concierge = privateKeyToAccount(env.concierge.key);
  const fetchImpl = d.fetchImpl ?? fetch;
  const say = (chatId: string, text: string, cards: Card[] = []) =>
    db.insert(messages).values({ chatId, role: "assistant", text, cards });

  async function call(row: typeof table.$inferSelect, action: string, body: unknown = {}) {
    const path = `/watches/${row.watchId}/${action}`;
    const text = JSON.stringify(body);
    const res = await fetchImpl(`${row.endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(concierge, "POST", path, text)),
      },
      body: text,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { watch?: WatchView; error?: string };
    if (!res.ok || !json.watch) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.watch;
  }

  /** Post what's new on one watch (and book, if the user asked for that). */
  async function follow(row: typeof table.$inferSelect, w: WatchView) {
    const route = `${w.input.origin}→${w.input.destination} on ${w.input.date}`;
    const status = row.status === "booked" ? "booked" : w.status;
    // Claim the new alerts and the status change: a timer tick and a look from the card can't
    // both post them.
    const [claimed] = await db
      .update(table)
      .set({ alertsSeen: w.alerts.length, status })
      .where(
        and(
          eq(table.watchId, row.watchId),
          eq(table.alertsSeen, row.alertsSeen),
          eq(table.status, row.status),
        ),
      )
      .returning({ id: table.watchId });
    if (!claimed) return;
    for (const a of w.alerts.slice(row.alertsSeen)) {
      const sim = a.simulated ? " (a SIMULATED drop for the sandbox demo, not a real price)" : "";
      await say(
        row.chatId,
        `FareWatch: ${route} is now ${inr(a.price)}, ${a.reason} (was ${inr(a.was)})${sim}. ${a.flight}`,
        [
          {
            type: "options",
            question: "Book it?",
            options: [
              {
                label: "Book it",
                reply: `Book the cheapest flight ${route} for ${w.input.adults} adult(s) now`,
              },
              { label: "Keep watching", reply: "Keep watching the fare" },
            ],
          },
        ],
      );
      const target = w.input.targetInr;
      if (w.input.autoBook && target !== undefined && a.price <= target && !a.simulated)
        await autoBook(row, w, target);
    }
    if (w.status === "ended" && row.status === "watching")
      await say(
        row.chatId,
        `FareWatch stopped watching ${route}: its time is up. Lowest seen: ${inr(w.lowest.price)}.`,
      );
  }

  /** The fare reached the user's target in a chat that pays by itself: book it like any hire. */
  async function autoBook(row: typeof table.$inferSelect, w: WatchView, target: number) {
    const hiring = d.hiring?.();
    const [chat] = await db.select().from(chats).where(eq(chats.id, row.chatId));
    if (!hiring || !chat || chat.mode !== "auto") return;
    const trip = {
      origin: w.input.origin,
      destination: w.input.destination,
      destinationName: w.input.destination,
      departDate: w.input.date,
      returnDate: addDay(w.input.date),
      returnFlight: false,
      adults: w.input.adults,
      budgetInr: target,
      nonRefundableOk: false,
      hotelWishes: "",
      notes: "booked on a FareWatch alert",
    };
    const { refs } = await hiring.quotes(chat, "flights", trip);
    const pick = refs
      .filter((r) => (r.option.priced?.itemInr ?? Number.POSITIVE_INFINITY) <= target)
      .sort((a, b) => (a.option.priced?.totalInr ?? 0) - (b.option.priced?.totalInr ?? 0))[0];
    if (!pick)
      return await say(
        row.chatId,
        "No flight agent can book it at your target right now, so I didn't book.",
      );
    const out = await hiring.hire(
      chat,
      pick.ref,
      "FareWatch: the fare reached your target",
      "booked on a FareWatch alert",
    );
    if (out.status === "hired") {
      await db.update(table).set({ status: "booked" }).where(eq(table.watchId, row.watchId));
      await call(row, "stop").catch(() => {});
      return await say(row.chatId, `Booked it, as you asked: ${pick.option.note}.`, [out.card]);
    }
    if ("card" in out)
      return await say(row.chatId, "The fare reached your target. Approve this to book it:", [
        out.card,
      ]);
    await say(row.chatId, `The fare reached your target, but I couldn't book: ${out.reason}`);
  }

  async function tick() {
    const rows = await db.select().from(table).where(eq(table.status, "watching"));
    for (const row of rows) {
      const w = await call(row, "view").catch(() => null);
      if (w) await follow(row, w).catch(() => {});
    }
  }
  const timer = setInterval(() => void tick().catch(() => {}), EVERY_MS);
  timer.unref?.();

  const mine = async (chatId: string, watchId: string) =>
    (
      await db
        .select()
        .from(table)
        .where(and(eq(table.chatId, chatId), eq(table.watchId, watchId)))
    )[0] ?? null;

  return {
    tick,
    simulate: !!d.simulate,

    /** A FareWatch hire was delivered: follow it, and give the chat a live card for it. */
    async add(chatId: string, hire: Hire): Promise<Extract<Card, { type: "watch" }> | null> {
      const r = hire.result as { watchId?: string } | null;
      if (hire.skill !== "farewatch" || !r?.watchId) return null;
      const row = {
        watchId: r.watchId,
        chatId,
        agent: hire.agent,
        endpoint: hire.endpoint,
        input: {},
      };
      const w = await call(
        { ...row, alertsSeen: 0, status: "watching", createdAt: new Date() },
        "view",
      ).catch(() => null);
      await db
        .insert(table)
        .values({ ...row, input: (w?.input ?? {}) as Record<string, unknown> })
        .onConflictDoNothing();
      return {
        type: "watch",
        watchId: r.watchId,
        title: hire.agentTitle.split(" — ")[0] ?? "FareWatch",
      };
    },

    /** The live view behind the chat's card; null if it isn't this chat's. */
    async status(chatId: string, watchId: string) {
      const row = await mine(chatId, watchId);
      if (!row) return null;
      const w = await call(row, "view");
      await follow(row, w).catch(() => {}); // a look from the card also posts what's new
      return { ...w, booked: row.status === "booked", canSimulate: !!d.simulate };
    },

    async act(chatId: string, watchId: string, action: "stop" | "check-now" | "simulate") {
      const row = await mine(chatId, watchId);
      if (!row) return null;
      const w = await call(row, action, action === "simulate" ? { percent: 10 } : {});
      if (action === "stop")
        await db.update(table).set({ status: "stopped" }).where(eq(table.watchId, watchId));
      else await follow(row, w);
      return w;
    },
  };
}

export type FareWatchFollower = ReturnType<typeof fareWatchFollower>;
