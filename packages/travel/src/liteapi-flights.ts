import { z } from "zod";
import { assertSandboxKey, LITEAPI_URL, litePost } from "./liteapi-http";
import type { Traveller } from "./types";

/**
 * LiteAPI (Nuitee Connect) flights, used with a **sandbox** key only (same key as hotels).
 * Sandbox data is not real inventory; booking with ACC_CREDIT_CARD is simulated — no charge,
 * no real ticket. Flow: search → prebook (holds the offer) → book.
 * Docs: https://docs.liteapi.travel/docs/getting-access-to-flights
 */

// Flights answers `data` as an array; accept a bare object too, in case an endpoint differs.
const first = <T extends z.ZodType>(item: T) =>
  z
    .union([z.array(item).min(1), item])
    .transform((v) => (Array.isArray(v) ? v[0] : v) as z.infer<T>);

const Segment = z.object({
  originCode: z.string(),
  destinationCode: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  direction: z.string().optional(),
  flight: z.object({ marketingNumber: z.string().optional() }).optional(),
  carrier: z.object({ marketingCode: z.string().optional(), marketingName: z.string() }),
});

const RatesResponse = z.object({
  data: z.array(
    z.object({
      journeys: z.array(
        z.object({
          segments: z.array(Segment),
          offers: z.array(
            z.object({
              offerId: z.string(),
              pricing: z.object({ display: z.object({ total: z.number(), currency: z.string() }) }),
              provider: z.object({ code: z.string() }).optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});

const PrebookResponse = z.object({ data: first(z.object({ prebookId: z.string() })) });

const BookResponse = z.object({
  data: first(
    z.object({
      booking: z.object({
        bookingId: z.string(),
        bookingRef: z.string().optional(),
        status: z.string(),
        order: z
          .object({
            reference: z
              .object({ airlineBookings: z.array(z.object({ airlinePnr: z.string() })) })
              .partial()
              .optional(),
          })
          .optional(),
        pricing: z.unknown().optional(),
      }),
    }),
  ),
});

export interface LiteFlightOffer {
  offerId: string;
  carrier: string;
  flightNumber?: string;
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  stops: number;
  total: number;
  currency: string;
  provider?: string;
}

export interface LiteFlightBooking {
  bookingId: string;
  bookingRef?: string;
  airlinePnr?: string;
  status: string;
}

export class LiteFlightsClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertSandboxKey(apiKey);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return litePost(this.fetchImpl, this.apiKey, `${LITEAPI_URL}${path}`, body);
  }

  /** One-way economy search; every offer, cheapest first. */
  async searchFlights(q: {
    origin: string;
    destination: string;
    date: string;
    adults: number;
    currency?: string;
  }): Promise<LiteFlightOffer[]> {
    const json = await this.post("/flights/rates", {
      legs: [{ origin: q.origin, destination: q.destination, date: q.date }],
      adults: q.adults,
      cabinClass: "ECONOMY",
      currency: q.currency ?? "INR",
      sort: { sortBy: "price", sortOrder: "asc" },
    });
    const journeys = RatesResponse.parse(json).data.flatMap((d) => d.journeys);
    return journeys
      .flatMap((j) => {
        const segs = j.segments.filter((s) => (s.direction ?? "OUTBOUND") === "OUTBOUND");
        const a = segs[0];
        const b = segs[segs.length - 1];
        if (!a || !b) return [];
        return j.offers.map(
          (o): LiteFlightOffer => ({
            offerId: o.offerId,
            carrier: a.carrier.marketingName,
            flightNumber: a.flight?.marketingNumber
              ? `${a.carrier.marketingCode ?? ""}${a.flight.marketingNumber}`
              : undefined,
            origin: a.originCode,
            destination: b.destinationCode,
            departAt: a.departureTime,
            arriveAt: b.arrivalTime,
            stops: segs.length - 1,
            total: o.pricing.display.total,
            currency: o.pricing.display.currency,
            provider: o.provider?.code,
          }),
        );
      })
      .sort((x, y) => x.total - y.total);
  }

  /** Holds the offer for these travellers (prebook), then books it with the sandbox card. */
  async book(offer: LiteFlightOffer, travellers: Traveller[]): Promise<LiteFlightBooking> {
    const lead = travellers[0];
    if (!lead) throw new Error("Need at least one traveller");
    const pre = await this.post("/flights/prebooks", {
      offerId: offer.offerId,
      usePaymentSdk: false,
      travelPurpose: "LEISURE",
      contact: {
        email: lead.email,
        firstName: lead.givenName,
        lastName: lead.familyName,
        phoneCountryCode: lead.phoneCountryCode,
        phoneNumber: lead.phone,
      },
      passengers: travellers.map((t) => ({
        title: t.title.toUpperCase(),
        firstName: t.givenName,
        lastName: t.familyName,
        gender: t.gender.toUpperCase(),
        birthday: t.bornOn,
        nationality: t.nationality,
        passengerType: 0, // adult
      })),
    });
    const { prebookId } = PrebookResponse.parse(pre).data;
    const json = await this.post("/flights/bookings", {
      prebookId,
      payment: { method: "ACC_CREDIT_CARD" },
    });
    const { booking } = BookResponse.parse(json).data;
    return {
      bookingId: booking.bookingId,
      bookingRef: booking.bookingRef,
      airlinePnr: booking.order?.reference?.airlineBookings?.[0]?.airlinePnr,
      status: booking.status,
    };
  }
}
