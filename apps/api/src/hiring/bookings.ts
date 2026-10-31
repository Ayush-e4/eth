import { type QuoteRound, signedHeaders } from "@eth/agents/hiring";
import type { Card } from "@eth/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { chats, hires } from "../db/schema";
import { approvalBook } from "./approvals";
import type { HiringEnv } from "./env";
import { quoteRefs } from "./quote-refs";

/** One flight the user booked through an agent, as it stands after any changes. */
export interface Booking {
  id: string; // the hire that booked it
  orderId: string;
  bookingReference: string;
  agent: string; // the agent's address
  agentTitle: string;
  endpoint: string | null;
  chatTitle: string;
  bookedAt: string;
  changes: number;
}

type Result = { orderId?: string; bookingReference?: string };

/**
 * "My bookings": flights the user booked through an agent (SkyHop), managed from any chat.
 * Requests to the agent are signed by the concierge, the buyer on the booking's Arkiv job;
 * whose booking it is, is checked here (its hire is in one of this user's chats).
 *   - view: the booking as the airline has it now;
 *   - change options: quoted by the agent as "flights.change" jobs, held as refs (q1…) that
 *     hire_agent pays like any hire. One that costs more at the airline needs an approval.
 *   - cancel: only after the user approves a card showing the refund.
 */
export function bookingDesk(
  db: Db,
  env: HiringEnv,
  opts: { requireHuman?: boolean; endpointOf?: (agent: string) => Promise<string | null> } = {},
) {
  const refs = quoteRefs(db);
  const approvals = approvalBook(db, opts.requireHuman);
  const concierge = privateKeyToAccount(env.concierge.key);

  async function list(userId: string): Promise<Booking[]> {
    const rows = await db
      .select({ hire: hires, chatTitle: chats.title })
      .from(hires)
      .innerJoin(chats, eq(chats.id, hires.chatId))
      .where(and(eq(chats.userId, userId), inArray(hires.skill, ["flights", "flights.change"])))
      .orderBy(asc(hires.createdAt));
    const byOrder = new Map<string, Booking>();
    for (const { hire: h, chatTitle } of rows) {
      const r = (h.result ?? {}) as Result;
      if (!r.orderId) continue; // not an agent whose bookings can be managed
      const had = byOrder.get(r.orderId);
      if (h.skill === "flights.change") {
        if (had) byOrder.set(r.orderId, { ...had, changes: had.changes + 1, ...ref(r, had) });
        continue;
      }
      byOrder.set(r.orderId, {
        id: h.id,
        orderId: r.orderId,
        bookingReference: r.bookingReference ?? "",
        agent: h.agent,
        agentTitle: h.title.split(" — ")[0] ?? h.title,
        endpoint: h.endpoint,
        chatTitle,
        bookedAt: h.createdAt.toISOString(),
        changes: 0,
      });
    }
    return [...byOrder.values()].reverse().slice(0, 20);
  }
  const ref = (r: Result, b: Booking) => ({
    bookingReference: r.bookingReference ?? b.bookingReference,
  });

  /** One of the user's bookings, by its id or booking reference. */
  async function find(userId: string, which: string) {
    const all = await list(userId);
    const b = all.find(
      (x) => x.id === which || x.bookingReference.toLowerCase() === which.toLowerCase(),
    );
    if (!b) throw new BookingError("no such booking of yours");
    const endpoint = b.endpoint ?? (await opts.endpointOf?.(b.agent)) ?? null;
    if (!endpoint) throw new BookingError(`${b.agentTitle} isn't reachable on the market now`);
    return { ...b, endpoint };
  }

  /** A signed request to the agent that made the booking. */
  async function call<T>(endpoint: string, path: string, body: unknown = {}): Promise<T> {
    const text = JSON.stringify(body);
    const res = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(concierge, "POST", path, text)),
      },
      body: text,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
    if (!res.ok)
      throw new BookingError(`${json.error ?? `HTTP ${res.status}`} ${json.detail ?? ""}`.trim());
    return json;
  }

  return {
    list,

    async view(userId: string, which: string) {
      const b = await find(userId, which);
      return call<{ booking: unknown }>(b.endpoint, `/bookings/${b.orderId}/view`);
    },

    async changeOptions(
      userId: string,
      chatId: string,
      which: string,
      q: { date: string; flight?: "outbound" | "return" },
    ) {
      const b = await find(userId, which);
      const out = await call<ChangeOptions>(b.endpoint, `/bookings/${b.orderId}/change-options`, q);
      const round: QuoteRound = {
        ...out.pay,
        options: out.options.map((o) => ({
          key: o.quoteKey as `0x${string}`,
          agent: b.agent as `0x${string}`,
          title: `${b.agentTitle} — move flight ${b.bookingReference}`,
          note: o.note,
          feeUnits: BigInt(Math.round(out.changeFeeUsdc * 1e6)),
          itemTotal: Number(o.changeTotal),
          itemCurrency: o.currency,
          endpoint: b.endpoint,
          ...(Number(o.changeTotal) > 0
            ? {
                confirm: `The airline charges ${o.changeTotal} ${o.currency} more for this change (penalty ${o.penalty} included).`,
              }
            : {}),
        })),
        bestReason: "the cheapest change first",
        skipped: [],
      };
      const held = await refs.hold(chatId, round);
      return { booking: b, current: out.current, held, round };
    },

    /** Cancels once the user approved it (a card shows the refund first). */
    async cancel(
      userId: string,
      chatId: string,
      which: string,
    ): Promise<
      | { status: "cancelled"; refund: string; currency: string }
      | { status: "needs_approval"; card: Extract<Card, { type: "approval" }> }
    > {
      const b = await find(userId, which);
      const key = `cancel:${b.orderId}`; // its own key: no other approval can stand in for it
      const quote = await call<CancelQuote>(b.endpoint, `/bookings/${b.orderId}/cancel-quote`);
      if (await approvals.take(chatId, key, key, 0n, true)) {
        await call(b.endpoint, `/bookings/${b.orderId}/cancel`, { quoteId: quote.quoteId });
        return { status: "cancelled", refund: quote.refund, currency: quote.currency };
      }
      const code = await approvals.ask(chatId, key, key, 0n);
      return {
        status: "needs_approval",
        card: {
          type: "approval",
          code,
          title: `Cancel flight ${b.bookingReference}`,
          detail: `${quote.refund} ${quote.currency} comes back of ${quote.paid} ${quote.paidCurrency} paid (test mode). It can't be undone.`,
          feeUnits: "0",
          ...(approvals.requireHuman ? { human: true } : {}),
        },
      };
    },
  };
}

export class BookingError extends Error {}
export type BookingDesk = ReturnType<typeof bookingDesk>;

interface ChangeOptions {
  current: string;
  options: {
    quoteKey: string;
    note: string;
    changeTotal: string;
    penalty: string;
    currency: string;
  }[];
  changeFeeUsdc: number;
  pay: { task: string; skill: string; input: unknown };
}
interface CancelQuote {
  quoteId: string;
  refund: string;
  currency: string;
  paid: string;
  paidCurrency: string;
}
