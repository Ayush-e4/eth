import { checkInvoice, fetchInrRates, signedHeaders, signStatement } from "@eth/agents/hiring";
import { arkivReader, invoicesFor } from "@eth/arkiv";
import type { Card } from "@eth/shared";
import { createPayingFetch, MirrorResolver } from "@eth/x402";
import { and, eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { chats, fareWatches } from "../db/schema";
import { approvalBook } from "./approvals";
import type { BookingDesk } from "./bookings";
import type { HiringEnv } from "./env";
import { currentMandate, limitCard } from "./mandates";
import { finishPaid } from "./record";
import type { ChatLike, HireOutcome } from "./service";

type Agent = { agent: string; endpoint: string };
interface GuardView {
  bookingId: string;
  status: "watching" | "stopped";
  invoices: { key: string; units: string; saving: number; currency: string; paid: boolean }[];
}
const MAX_FEE = 5_000_000n; // never more than 5 USDC for one success fee (as the old buyer)

/**
 * PriceGuard from the chat: it watches a hotel the user booked through StayWise and, if the
 * same stay gets cheaper (by the user's limits) before free cancellation closes, has StayWise
 * rebook it and invoices 20% of the saving with StayWise's signed proof. The user's permission
 * slip is signed by the concierge (the booking's buyer on Arkiv). The invoice is paid only when
 * the user asks, after its proof is checked here; a fee above the chat's limit asks for a
 * one-off limit just for it. Web2 analogy: a price-drop refund service paid on results.
 */
export function hotelGuard(
  db: Db,
  env: HiringEnv,
  d: {
    desk: BookingDesk;
    findAgent: (skill: string) => Promise<Agent | null>;
    requireHuman?: boolean;
    allowSimulated?: boolean; // sandbox demos only: pay for a SIMULATED saving
  },
) {
  const concierge = privateKeyToAccount(env.concierge.key);
  const approvals = approvalBook(db, d.requireHuman);
  // One-off limits offered for a fee, by chat: the limit route accepts exactly these.
  const offers = new Map<string, { units: bigint; payee: string }>();

  async function post<T>(url: string, path: string, body: unknown): Promise<T> {
    const text = JSON.stringify(body);
    const res = await fetch(`${url}${path}`, {
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
      throw new Error(`${json.error ?? `HTTP ${res.status}`} ${json.detail ?? ""}`.trim());
    return json;
  }

  return {
    /** Is this the one-off limit we offered this chat for a fee (amount, payee, cap)? */
    offered(chatId: string, card: Extract<Card, { type: "limit" }>) {
      const o = offers.get(chatId);
      return (
        !!o &&
        card.budgetUnits === o.units.toString() &&
        card.perPaymentCapUnits === o.units.toString() &&
        card.payees.length === 1 &&
        card.payees[0]?.agent.toLowerCase() === o.payee.toLowerCase()
      );
    },

    /** Turn PriceGuard on for one of the user's hotels. Returns the chat's live card for it. */
    async start(
      userId: string,
      chatId: string,
      which: string,
      limits: { minSavingInr: number; minSavingPercent: number },
    ): Promise<Extract<Card, { type: "watch" }>> {
      const b = await d.desk.find(userId, which);
      if (b.kind !== "hotel") throw new Error("PriceGuard watches hotel bookings");
      const pg = await d.findAgent("priceguard");
      if (!pg) throw new Error("PriceGuard isn't on the market right now");
      const { booking } = await d.desk.view(userId, which);
      const h = booking as { checkin?: string; hotelName?: string; checkout?: string };
      const slip = await signStatement(concierge, "reprice-delegation", {
        bookingId: b.bookingId,
        agent: b.agent as `0x${string}`,
        delegate: pg.agent as `0x${string}`,
        ...limits,
        until: h.checkin ?? "",
        issuedAt: Date.now(),
      });
      const task = `guard-${b.bookingId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
      await post(pg.endpoint, "/watch", {
        task,
        bookingId: b.bookingId,
        stayEndpoint: b.endpoint,
        stayAgent: b.agent,
        delegation: slip,
      });
      await db
        .insert(fareWatches)
        .values({
          watchId: task,
          chatId,
          kind: "hotel",
          agent: pg.agent,
          endpoint: pg.endpoint,
          input: {
            bookingId: b.bookingId,
            hotel: h.hotelName,
            checkin: h.checkin,
            checkout: h.checkout,
            ...limits,
          },
        })
        .onConflictDoUpdate({ target: fareWatches.watchId, set: { status: "watching", chatId } });
      return { type: "watch", watchId: task, title: "PriceGuard", kind: "hotel" };
    },

    /** Pay one of PriceGuard's invoices, after checking its proof, within the chat's limits. */
    async pay(userId: string, chat: ChatLike, key: string): Promise<HireOutcome> {
      const watches = await db
        .select({ w: fareWatches })
        .from(fareWatches)
        .innerJoin(chats, eq(chats.id, fareWatches.chatId))
        .where(and(eq(chats.userId, userId), eq(fareWatches.kind, "hotel")));
      let found: { w: typeof fareWatches.$inferSelect; inv: GuardView["invoices"][number] } | null =
        null;
      for (const { w } of watches) {
        const v = await post<{ watch: GuardView }>(
          w.endpoint,
          `/watches/${w.watchId}/view`,
          {},
        ).catch(() => null);
        const inv = v?.watch.invoices.find((i) => i.key === key);
        if (inv) found = { w, inv };
      }
      if (!found) return { status: "refused", reason: "no such PriceGuard invoice of yours" };
      if (found.inv.paid) return { status: "refused", reason: "that invoice is already paid" };
      // The invoice on Arkiv, its proof checked: signed by the hotel's agent, a real saving, 20%.
      const record = (await invoicesFor(arkivReader(), concierge.address)).find(
        (i) => i.key === key,
      );
      if (!record) return { status: "refused", reason: "PriceGuard's invoice isn't on Arkiv yet" };
      const input = found.w.input as { bookingId?: string };
      const stay = await d.desk.find(userId, input.bookingId ?? "").catch(() => null);
      const check = await checkInvoice(record, {
        hotelAgent: stay?.agent ?? "",
        tripBookings: [input.bookingId ?? "", ...(stay ? [stay.bookingId] : [])],
        inrPerUsdc: (await fetchInrRates()).USDC ?? 0,
        allowSimulated: d.allowSimulated,
      });
      if (!check.ok) return { status: "refused", reason: `Not paid: ${check.reason}` };
      const units = check.units;
      if (units > MAX_FEE) return { status: "refused", reason: "the fee is above the 5 USDC cap" };
      // Within the chat's limit if it covers PriceGuard and has room; else a limit just for this.
      const m = await currentMandate(db, env, chat.id);
      const onChain = m ? await env.mc.getMandate(m.mandateId).catch(() => null) : null;
      const left = m ? await env.mc.remaining(m.mandateId).catch(() => 0n) : 0n;
      const fits =
        !!m &&
        m.payees.some((p) => p.toLowerCase() === found.w.agent.toLowerCase()) &&
        left >= units &&
        (onChain?.perPaymentCap ?? 0n) >= units;
      if (!fits) {
        offers.set(chat.id, { units, payee: found.w.agent });
        return {
          status: "needs_limit",
          card: {
            ...limitCard(env, units, [
              { name: "PriceGuard", agent: found.w.agent as `0x${string}` },
            ]),
            perPaymentCapUnits: units.toString(),
          },
        };
      }
      const ref = `invoice:${key}`;
      if (chat.mode === "ask" && !(await approvals.take(chat.id, ref, ref, units, true))) {
        const code = await approvals.ask(chat.id, ref, ref, units);
        return {
          status: "needs_approval",
          card: {
            type: "approval",
            code,
            title: "Pay PriceGuard",
            detail: `It rebooked your hotel and saved ${check.proof.saving} ${check.proof.currency} (${check.proof.oldBookingId} → ${check.proof.newBookingId}); its fee is 20% of that.`,
            feeUnits: units.toString(),
            ...(approvals.requireHuman ? { human: true } : {}),
          },
        };
      }
      const pay = createPayingFetch({
        agent: concierge,
        mandateId: (m as NonNullable<typeof m>).mandateId,
        payer: (m as NonNullable<typeof m>).payer,
        executor: env.registryId,
        executorEvm: env.registry,
        chainId: env.mc.chain.id,
        resolver: new MirrorResolver(env.mirrorUrl),
        maxAmount: units,
      });
      const { response, paid } = await pay(`${found.w.endpoint}/invoices/${key}/pay`, {
        method: "POST",
      });
      if (!response.ok || !paid)
        return {
          status: "refused",
          reason: `PriceGuard didn't take the payment (HTTP ${response.status})`,
        };
      const card = await finishPaid(db, env, {
        chatId: chat.id,
        mandateId: (m as NonNullable<typeof m>).mandateId,
        skill: "priceguard",
        agent: found.w.agent,
        endpoint: found.w.endpoint,
        title: "PriceGuard",
        summary: `success fee: 20% of the ${check.proof.saving} ${check.proof.currency} it saved`,
        feeUnits: units,
        hederaTx: paid.settlement.transaction,
        jobKey: key,
        result: {
          invoice: key,
          saving: check.proof.saving,
          newBookingId: check.proof.newBookingId,
        },
      });
      return { status: "hired", card, result: card.summary };
    },
  };
}

export type HotelGuard = ReturnType<typeof hotelGuard>;
