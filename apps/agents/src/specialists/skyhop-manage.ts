import type { ArkivReader } from "@eth/arkiv";
import type { DuffelOrders, FlightChangeOffer, FlightOrder } from "@eth/travel";
import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import type { JsonStore } from "../store";
import type { FollowUp, SpecialistKit } from "./server";
import { bookingOwner, signerOf } from "./staywise-manage";

export const FLIGHT_CHANGE_FEE = 20_000n; // 0.02 USDC to move a flight
const SHOWN = 3; // different change options quoted per request

/** What SkyHop remembers about each flight it booked: its own records. */
export interface FlightRecord {
  bookingId: string; // the Duffel order id
  task: string;
  quoteKey: string; // the quote the buyer paid for; its Arkiv job names the buyer
  bookingReference: string;
  owner?: `0x${string}`; // the buyer, once confirmed from Arkiv
}

export interface FlightManageDeps {
  orders: DuffelOrders;
  store: JsonStore<FlightRecord>;
  arkiv: ArkivReader;
}

/** What a change quote stands for: this order, moved to this Duffel change offer. */
export interface ChangeDetail {
  orderId: string;
  offer: FlightChangeOffer;
}

const ChangeInput = z.object({ orderId: z.string().min(1).max(80) });
const OptionsBody = z.object({
  flight: z.enum(["outbound", "return"]).default("outbound"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const CancelBody = z.object({ quoteId: z.string().min(1).max(80) });

const leg = (f: FlightOrder["flights"][number] | FlightChangeOffer["flights"][number]) =>
  `${f.flightNumber ?? f.carrier} ${f.origin}→${f.destination} ${f.departAt.replace("T", " ").slice(0, 16)}`;

/**
 * SkyHop's booking management (Duffel test mode), next to /quote and /work:
 *   POST /bookings/:id/view            free  the booking, and whether it can be changed/cancelled
 *   POST /bookings/:id/change-options  free  ways to move a flight to another day, each quoted
 *                                            on Arkiv as a "flights.change" job (paid via /work)
 *   POST /bookings/:id/cancel-quote    free  what cancelling now would refund
 *   POST /bookings/:id/cancel          free  cancel, with that quote
 * Only the buyer on the booking's Arkiv job may (requests signed, checked before anything).
 */
export function flightManagement(deps: FlightManageDeps, me: string) {
  const ownerOf = bookingOwner(deps, me);
  const owns = async (rec: FlightRecord | undefined, who: string | null) => {
    const owner = rec && (await ownerOf(rec));
    return !!owner && !!who && owner.toLowerCase() === who.toLowerCase();
  };

  /** The paid follow-up: move a flight to the quoted change offer. */
  const change: FollowUp<z.infer<typeof ChangeInput>, ChangeDetail> = {
    input: ChangeInput,
    priceUnits: FLIGHT_CHANGE_FEE,
    async check(req, detail, buyer) {
      if (req.input.orderId !== detail.orderId) return "that change quote is for another booking";
      return (await owns(deps.store.get(detail.orderId), buyer)) ? null : "not your booking";
    },
    async work(_req, detail) {
      const done = await deps.orders.change(detail.offer.offerId);
      const rec = deps.store.get(detail.orderId);
      if (rec) deps.store.set(rec.bookingId, { ...rec, bookingReference: done.bookingReference });
      return {
        orderId: done.orderId,
        bookingReference: done.bookingReference,
        flights: done.flights.map(leg),
        paidForChange: `${done.paid} ${done.currency}`,
      };
    },
  };

  const routes = (app: Hono, kit: SpecialistKit) => {
    const cancelQuotes = new Map<string, string>(); // quote id → the booking it was given for
    const record = (c: Context) => c.get("booking" as never) as FlightRecord;
    const guard = async (c: Context, next: Next) => {
      const rec = deps.store.get(c.req.param("id") ?? "");
      if (!rec) return c.json({ error: "unknown_booking" }, 404);
      const signer = await signerOf(c);
      if (!signer) return c.json({ error: "unauthorized" }, 401);
      if (!(await owns(rec, signer))) return c.json({ error: "not_your_booking" }, 403);
      c.set("booking" as never, rec as never);
      await next();
    };

    app.post("/bookings/:id/view", guard, async (c) => {
      const order = await deps.orders.get(record(c).bookingId);
      return c.json({ agent: "SkyHop", booking: { ...order, flights: order.flights.map(leg) } });
    });

    app.post("/bookings/:id/change-options", guard, async (c) => {
      const rec = record(c);
      const q = OptionsBody.parse(await c.req.json().catch(() => ({})));
      const order = await deps.orders.get(rec.bookingId);
      if (!order.canChange) return c.json({ error: "change_not_allowed", booking: order }, 409);
      const flight = order.flights[q.flight === "return" ? 1 : 0];
      if (!flight) return c.json({ error: "no_such_flight" }, 404);
      // Duffel lists the same flight at the same price many times: keep one of each.
      const seen = new Set<string>();
      const offers = (await deps.orders.changeOffers(rec.bookingId, flight.sliceId, q.date))
        .filter((o) => {
          const k = `${o.flights.map(leg).join()}|${o.changeTotal}`;
          return !seen.has(k) && !!seen.add(k);
        })
        .slice(0, SHOWN);
      const options = [];
      for (const offer of offers) {
        const note = `${offer.flights.map(leg).join(", ")}: costs ${offer.changeTotal} ${offer.currency} more (airline penalty ${offer.penalty}), new total ${offer.newTotal}`;
        // A quote Arkiv didn't take is left out; the others still stand.
        const quoteKey = await kit
          .quote({
            task: rec.task,
            skill: "flights.change",
            note,
            detail: { orderId: rec.bookingId, offer } satisfies ChangeDetail,
            itemTotal: Number(offer.changeTotal),
            itemCurrency: offer.currency,
          })
          .catch(() => null);
        if (quoteKey) options.push({ quoteKey, note, ...offer });
      }
      if (offers.length && !options.length)
        return c.json(
          { error: "quote_failed", detail: "couldn't post the quotes; try again" },
          502,
        );
      return c.json({
        current: leg(flight),
        options,
        changeFeeUsdc: Number(FLIGHT_CHANGE_FEE) / 1e6,
        pay: { task: rec.task, skill: "flights.change", input: { orderId: rec.bookingId } },
      });
    });

    app.post("/bookings/:id/cancel-quote", guard, async (c) => {
      const rec = record(c);
      const order = await deps.orders.get(rec.bookingId);
      if (!order.canCancel) return c.json({ error: "cancel_not_allowed", booking: order }, 409);
      const quote = await deps.orders.cancelQuote(rec.bookingId);
      cancelQuotes.set(quote.quoteId, rec.bookingId);
      return c.json({ ...quote, paid: order.total, paidCurrency: order.currency });
    });

    app.post("/bookings/:id/cancel", guard, async (c) => {
      const { quoteId } = CancelBody.parse(await c.req.json());
      if (cancelQuotes.get(quoteId) !== record(c).bookingId)
        return c.json({ error: "unknown_cancel_quote", detail: "get a fresh cancel quote" }, 409);
      cancelQuotes.delete(quoteId);
      return c.json({ agent: "SkyHop", result: await deps.orders.cancel(quoteId) });
    });
  };

  return { change, routes };
}
