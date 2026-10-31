import { type QuoteOption, type QuoteRound, signedHeaders } from "@eth/agents/hiring";
import type { Card } from "@eth/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { chats, hires } from "../db/schema";
import { approvalBook } from "./approvals";
import type { HiringEnv } from "./env";
import { quoteRefs } from "./quote-refs";

/** One booking the user made through an agent, as it stands after any changes. */
export interface Booking {
  id: string; // the hire that booked it
  kind: "flight" | "hotel";
  bookingId: string; // the agent's id for it now (a hotel change makes a new one)
  bookingReference: string;
  agent: string; // the agent's address
  agentTitle: string;
  endpoint: string | null;
  chatTitle: string;
  bookedAt: string;
  changes: number;
}

type Result = {
  orderId?: string; // flights (Duffel order)
  bookingReference?: string;
  bookingId?: string; // hotels (LiteAPI booking)
  replaces?: string; // a hotel change: the booking it replaced
  queued?: boolean;
};
type ChangeQuery = {
  date?: string; // flights
  flight?: "outbound" | "return";
  checkin?: string; // hotels
  checkout?: string;
  adults?: number;
};

const SKILLS = ["flights", "flights.change", "hotels", "hotels.change"];

/**
 * "My bookings": flights (SkyHop) and hotels (StayWise) the user booked through an agent,
 * managed from any chat. Requests to the agent are signed by the concierge, the buyer on the
 * booking's Arkiv job; whose booking it is, is checked here (its hire is in this user's chats).
 *   - view: the booking as the airline or hotel has it now;
 *   - change options: quoted by the agent as "flights.change" / "hotels.change" jobs, held as
 *     refs (q1…) that hire_agent pays like any hire. One that costs more needs an approval.
 *   - cancel: only after the user approves a card showing what comes back.
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
      .where(and(eq(chats.userId, userId), inArray(hires.skill, SKILLS)))
      .orderBy(asc(hires.createdAt));
    const all: Booking[] = [];
    const now = (id: string) => all.find((b) => b.bookingId === id);
    for (const { hire: h, chatTitle } of rows) {
      const r = (h.result ?? {}) as Result;
      const was = h.skill === "flights.change" ? r.orderId : r.replaces;
      const had = was ? now(was) : undefined;
      if (h.skill.endsWith(".change")) {
        if (!had) continue;
        had.changes += 1;
        // A hotel change is a new booking: its id is the reference from now on.
        if (h.skill === "hotels.change" && r.bookingId && !r.queued)
          had.bookingId = had.bookingReference = r.bookingId;
        if (r.bookingReference) had.bookingReference = r.bookingReference;
        continue;
      }
      const id = r.orderId ?? r.bookingId;
      if (!id) continue; // not an agent whose bookings can be managed
      all.push({
        id: h.id,
        kind: h.skill === "flights" ? "flight" : "hotel",
        bookingId: id,
        // Hotels: the booking id (sandbox confirmation codes are all "test").
        bookingReference: r.bookingReference ?? id,
        agent: h.agent,
        agentTitle: h.title.split(" — ")[0] ?? h.title,
        endpoint: h.endpoint,
        chatTitle,
        bookedAt: h.createdAt.toISOString(),
        changes: 0,
      });
    }
    return all.reverse().slice(0, 20);
  }

  /** One of the user's bookings, by its id or booking reference. */
  async function find(userId: string, which: string) {
    const all = await list(userId);
    const w = which.toLowerCase();
    const b = all.find(
      (x) => x.id === which || x.bookingReference.toLowerCase() === w || x.bookingId === which,
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

  /** How one change option reads, and why it needs an approval (it costs more). */
  const optionOf = (b: Booking & { endpoint: string }, o: ChangeOptionWire, fee: bigint) => {
    const extra =
      b.kind === "flight"
        ? Number(o.changeTotal) > 0 &&
          `The airline charges ${o.changeTotal} ${o.currency} more for this change (penalty ${o.penalty} included).`
        : (o.priceDifferencePercent ?? 0) > 0 &&
          `It costs ${o.priceDifferencePercent}% more than what was paid: ${o.total} ${o.currency} in all.`;
    const option: QuoteOption = {
      key: o.quoteKey as `0x${string}`,
      agent: b.agent as `0x${string}`,
      title: `${b.agentTitle} — change ${b.kind} ${b.bookingReference}`,
      note: o.note,
      feeUnits: fee,
      itemTotal: Number(b.kind === "flight" ? o.changeTotal : o.total),
      itemCurrency: o.currency,
      endpoint: b.endpoint,
      ...(extra ? { confirm: extra } : {}),
    };
    return option;
  };

  return {
    list,

    async view(userId: string, which: string) {
      const b = await find(userId, which);
      return call<{ booking: unknown }>(b.endpoint, `/bookings/${b.bookingId}/view`);
    },

    async changeOptions(userId: string, chatId: string, which: string, q: ChangeQuery) {
      const b = await find(userId, which);
      const body =
        b.kind === "flight"
          ? { date: q.date, flight: q.flight }
          : { checkin: q.checkin, checkout: q.checkout, adults: q.adults ?? 1 };
      const out = await call<ChangeOptions>(
        b.endpoint,
        `/bookings/${b.bookingId}/change-options`,
        body,
      );
      const fee = BigInt(Math.round(out.changeFeeUsdc * 1e6));
      const round: QuoteRound = {
        ...out.pay,
        options: out.options.map((o) => optionOf(b, o, fee)),
        bestReason: "the cheapest change first",
        skipped: [],
      };
      const held = await refs.hold(chatId, round);
      const current = typeof out.current === "string" ? out.current : b.bookingReference;
      return { booking: b, current, held, round };
    },

    /** Cancels once the user approved it (a card shows what comes back first). */
    async cancel(
      userId: string,
      chatId: string,
      which: string,
    ): Promise<
      | { status: "cancelled"; refund: string; currency: string }
      | { status: "needs_approval"; card: Extract<Card, { type: "approval" }> }
    > {
      const b = await find(userId, which);
      const key = `cancel:${b.bookingId}`; // its own key: no other approval can stand in for it
      const path = `/bookings/${b.bookingId}`;
      // What comes back: the airline's cancellation quote, or the hotel's fee for cancelling now.
      const q =
        b.kind === "flight"
          ? await call<CancelQuote>(b.endpoint, `${path}/cancel-quote`)
          : await call<HotelView>(b.endpoint, `${path}/view`).then(
              ({ booking: h, cancelFeeNow }): CancelQuote => ({
                quoteId: "",
                refund: String(Math.max(0, (h.total ?? 0) - cancelFeeNow)),
                currency: h.currency ?? "",
                paid: String(h.total ?? 0),
                paidCurrency: h.currency ?? "",
              }),
            );
      if (await approvals.take(chatId, key, key, 0n, true)) {
        await call(b.endpoint, `${path}/cancel`, b.kind === "flight" ? { quoteId: q.quoteId } : {});
        return { status: "cancelled", refund: q.refund, currency: q.currency };
      }
      const code = await approvals.ask(chatId, key, key, 0n);
      return {
        status: "needs_approval",
        card: {
          type: "approval",
          code,
          title: `Cancel ${b.kind} ${b.bookingReference}`,
          detail: `${q.refund} ${q.currency} comes back of ${q.paid} ${q.paidCurrency} paid (test mode). It can't be undone.`,
          feeUnits: "0",
          ...(approvals.requireHuman ? { human: true } : {}),
        },
      };
    },
  };
}

export class BookingError extends Error {}
export type BookingDesk = ReturnType<typeof bookingDesk>;

interface ChangeOptionWire {
  quoteKey: string;
  note: string;
  currency: string;
  changeTotal?: string; // flights
  penalty?: string;
  total?: number; // hotels
  priceDifferencePercent?: number;
}
interface ChangeOptions {
  current: unknown;
  options: ChangeOptionWire[];
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
interface HotelView {
  booking: { total?: number; currency?: string };
  cancelFeeNow: number;
}
