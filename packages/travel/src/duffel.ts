import { z } from "zod";
import type { FlightLeg, Traveller } from "./types";

/**
 * Duffel flights API, used in **test mode** only (token starts with `duffel_test_`).
 * Test mode books on "Duffel Airways" (ZZ) with unrealistic prices — no real tickets — and the
 * test balance is unlimited. Prices come in the account's billing currency (GBP here).
 * Docs: https://duffel.com/docs/api/v2
 */

const BASE = "https://api.duffel.com";

const OfferRequestResponse = z.object({
  data: z.object({
    passengers: z.array(z.object({ id: z.string() })),
    offers: z.array(
      z.object({
        id: z.string(),
        total_amount: z.string(),
        total_currency: z.string(),
        slices: z.array(
          z.object({
            segments: z.array(
              z.object({
                departing_at: z.string(),
                arriving_at: z.string(),
                origin: z.object({ iata_code: z.string() }),
                destination: z.object({ iata_code: z.string() }),
                marketing_carrier: z.object({ name: z.string(), iata_code: z.string().optional() }),
                marketing_carrier_flight_number: z.string().optional(),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});

const OrderResponse = z.object({
  data: z.object({
    id: z.string(),
    booking_reference: z.string(),
    total_amount: z.string(),
    total_currency: z.string(),
  }),
});

export interface DuffelOffer {
  offerId: string;
  passengerIds: string[];
  outbound: FlightLeg;
  inbound?: FlightLeg; // present for round trips
  total: string; // whole itinerary, all passengers — kept as Duffel's string for the payment
  currency: string;
}

export interface DuffelBooking {
  orderId: string;
  bookingReference: string;
  total: string;
  currency: string;
}

export class DuffelClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token.startsWith("duffel_test_")) {
      throw new Error("Refusing to use a Duffel token that is not a test-mode token");
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ data: body }),
    });
    if (!res.ok) throw new Error(`Duffel ${path} → HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  /** One-way, or round trip when `returnDate` is set; offers cheapest first. */
  async searchFlights(q: {
    origin: string;
    destination: string;
    date: string;
    returnDate?: string;
    adults: number;
  }): Promise<DuffelOffer[]> {
    const slices = [{ origin: q.origin, destination: q.destination, departure_date: q.date }];
    if (q.returnDate) {
      slices.push({ origin: q.destination, destination: q.origin, departure_date: q.returnDate });
    }
    const json = await this.post("/air/offer_requests?return_offers=true", {
      slices,
      passengers: Array.from({ length: q.adults }, () => ({ type: "adult" })),
      cabin_class: "economy",
    });
    const { data } = OfferRequestResponse.parse(json);
    const passengerIds = data.passengers.map((p) => p.id);
    return data.offers
      .flatMap((o): DuffelOffer[] => {
        const outbound = legOf(o.slices[0]?.segments ?? []);
        const inbound = q.returnDate ? legOf(o.slices[1]?.segments ?? []) : undefined;
        if (!outbound || (q.returnDate && !inbound)) return [];
        return [
          {
            offerId: o.id,
            passengerIds,
            outbound,
            inbound,
            total: o.total_amount,
            currency: o.total_currency,
          },
        ];
      })
      .sort((a, b) => Number(a.total) - Number(b.total));
  }

  /** Books an offer instantly, paid from the Duffel test balance. */
  async bookFlight(offer: DuffelOffer, travellers: Traveller[]): Promise<DuffelBooking> {
    if (travellers.length !== offer.passengerIds.length) {
      throw new Error("Need one traveller per passenger on the offer");
    }
    const json = await this.post("/air/orders", {
      type: "instant",
      selected_offers: [offer.offerId],
      payments: [{ type: "balance", amount: offer.total, currency: offer.currency }],
      passengers: travellers.map((t, i) => ({
        id: offer.passengerIds[i],
        title: t.title,
        given_name: t.givenName,
        family_name: t.familyName,
        gender: t.gender,
        born_on: t.bornOn,
        email: t.email,
        phone_number: `+${t.phoneCountryCode}${t.phone}`,
      })),
    });
    const { data } = OrderResponse.parse(json);
    return {
      orderId: data.id,
      bookingReference: data.booking_reference,
      total: data.total_amount,
      currency: data.total_currency,
    };
  }
}

type Segment = z.infer<
  typeof OfferRequestResponse
>["data"]["offers"][number]["slices"][number]["segments"][number];

function legOf(segs: Segment[]): FlightLeg | undefined {
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!first || !last) return undefined;
  const code = first.marketing_carrier.iata_code ?? "";
  return {
    carrier: first.marketing_carrier.name,
    flightNumber: first.marketing_carrier_flight_number
      ? `${code}${first.marketing_carrier_flight_number}`
      : undefined,
    origin: first.origin.iata_code,
    destination: last.destination.iata_code,
    departAt: first.departing_at,
    arriveAt: last.arriving_at,
    stops: segs.length - 1,
  };
}
