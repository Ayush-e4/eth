import { z } from "zod";
import { type DuffelClient, legOf, SegmentSchema } from "./duffel";
import type { FlightLeg } from "./types";

/**
 * Managing a Duffel order after it's booked (test mode): read it, move a flight to another day,
 * cancel it. A change is three steps on Duffel (request → pick an offer → confirm, paid from
 * the balance); a cancellation is a quote you confirm. Amounts are Duffel's strings, in the
 * account's currency (GBP here). In test mode, Duffel Airways (ZZ) orders allow both.
 */

const Slice = z.object({ id: z.string(), segments: z.array(SegmentSchema) });
const Order = z.object({
  id: z.string(),
  booking_reference: z.string(),
  total_amount: z.string(),
  total_currency: z.string(),
  available_actions: z.array(z.string()).default([]),
  cancelled_at: z.string().nullable().optional(),
  slices: z.array(Slice),
});
const ChangeOffer = z.object({
  id: z.string(),
  expires_at: z.string(),
  change_total_amount: z.string(),
  change_total_currency: z.string(),
  penalty_total_amount: z.string().nullable().optional(),
  new_total_amount: z.string(),
  slices: z.object({ add: z.array(Slice) }),
});
const ChangeRequest = z.object({ id: z.string(), order_change_offers: z.array(ChangeOffer) });
const PendingChange = z.object({
  id: z.string(),
  change_total_amount: z.string(),
  change_total_currency: z.string(),
});
const Cancellation = z.object({
  id: z.string(),
  refund_amount: z.string().nullable(),
  refund_currency: z.string().nullable(),
  expires_at: z.string().nullable().optional(),
});
const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export interface FlightOrder {
  orderId: string;
  bookingReference: string;
  total: string;
  currency: string;
  canChange: boolean;
  canCancel: boolean;
  cancelled: boolean;
  /** Outbound first, then the return flight (if any); `sliceId` is what a change replaces. */
  flights: (FlightLeg & { sliceId: string })[];
}

export interface FlightChangeOffer {
  offerId: string;
  expiresAt: string;
  /** What the change costs on top of what was paid: fare difference plus the airline penalty. */
  changeTotal: string;
  penalty: string;
  newTotal: string;
  currency: string;
  flights: FlightLeg[]; // the replacement flight(s)
}

export interface FlightCancelQuote {
  quoteId: string;
  refund: string; // what comes back ("0" if nothing)
  currency: string;
  expiresAt?: string;
}

export class DuffelOrders {
  constructor(private readonly duffel: DuffelClient) {}

  async get(orderId: string): Promise<FlightOrder> {
    const o = data(Order).parse(await this.duffel.call("GET", `/air/orders/${orderId}`)).data;
    return {
      orderId: o.id,
      bookingReference: o.booking_reference,
      total: o.total_amount,
      currency: o.total_currency,
      canChange: o.available_actions.includes("change"),
      canCancel: o.available_actions.includes("cancel"),
      cancelled: !!o.cancelled_at,
      flights: o.slices.flatMap((s) => {
        const leg = legOf(s.segments);
        return leg ? [{ ...leg, sliceId: s.id }] : [];
      }),
    };
  }

  /** Ways to move one flight of the order to `date`, cheapest change first. */
  async changeOffers(orderId: string, sliceId: string, date: string): Promise<FlightChangeOffer[]> {
    const order = await this.get(orderId);
    const flight = order.flights.find((f) => f.sliceId === sliceId);
    if (!flight) throw new Error(`no flight ${sliceId} on order ${orderId}`);
    const json = await this.duffel.call("POST", "/air/order_change_requests", {
      order_id: orderId,
      slices: {
        remove: [{ slice_id: sliceId }],
        add: [
          {
            origin: flight.origin,
            destination: flight.destination,
            departure_date: date,
            cabin_class: "economy",
          },
        ],
      },
    });
    const req = data(ChangeRequest).parse(json).data;
    return req.order_change_offers
      .map((o) => ({
        offerId: o.id,
        expiresAt: o.expires_at,
        changeTotal: o.change_total_amount,
        penalty: o.penalty_total_amount ?? "0",
        newTotal: o.new_total_amount,
        currency: o.change_total_currency,
        flights: o.slices.add.flatMap((s) => legOf(s.segments) ?? []),
      }))
      .sort((a, b) => Number(a.changeTotal) - Number(b.changeTotal));
  }

  /** Makes the change, paying any difference from the Duffel (test) balance. */
  async change(offerId: string): Promise<FlightOrder & { paid: string }> {
    const pending = data(PendingChange).parse(
      await this.duffel.call("POST", "/air/order_changes", {
        selected_order_change_offer: offerId,
      }),
    ).data;
    const owed = Number(pending.change_total_amount) > 0;
    const confirmed = z.object({ data: z.object({ order_id: z.string() }) }).parse(
      await this.duffel.call(
        "POST",
        `/air/order_changes/${pending.id}/actions/confirm`,
        owed
          ? {
              payment: {
                type: "balance",
                amount: pending.change_total_amount,
                currency: pending.change_total_currency,
              },
            }
          : {},
      ),
    ).data;
    return { ...(await this.get(confirmed.order_id)), paid: pending.change_total_amount };
  }

  /** What cancelling now would refund (nothing is cancelled yet). */
  async cancelQuote(orderId: string): Promise<FlightCancelQuote> {
    const c = data(Cancellation).parse(
      await this.duffel.call("POST", "/air/order_cancellations", { order_id: orderId }),
    ).data;
    return {
      quoteId: c.id,
      refund: c.refund_amount ?? "0",
      currency: c.refund_currency ?? "",
      ...(c.expires_at ? { expiresAt: c.expires_at } : {}),
    };
  }

  async cancel(quoteId: string): Promise<{ cancelled: true }> {
    await this.duffel.call("POST", `/air/order_cancellations/${quoteId}/actions/confirm`);
    return { cancelled: true };
  }
}
