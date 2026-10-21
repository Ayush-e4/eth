import { z } from "zod";
import { assertSandboxKey, LITEAPI_BOOK_URL, LITEAPI_URL, liteGet, litePost } from "./liteapi-http";

/**
 * LiteAPI (Nuitee Connect) hotels, used with a **sandbox** key only (starts with `sand_`).
 * Sandbox bookings with payment method ACC_CREDIT_CARD are simulated — nobody is charged.
 * Docs: https://docs.liteapi.travel/reference/overview
 */

const Money = z.object({ amount: z.number(), currency: z.string() });

const SemanticResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      score: z.number(),
      city: z.string().optional(),
      location_type: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  ),
});

const RatesResponse = z.object({
  // "No availability" comes back as HTTP 200 with { error: { code: 2001 } } and no data.
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
  data: z.array(
    z.object({
      hotelId: z.string(),
      roomTypes: z.array(
        z.object({
          offerId: z.string(),
          name: z.string().optional(),
          // The sandbox returns one { amount, currency }; older docs show a list — accept both.
          offerRetailRate: z.union([Money, z.array(Money)]).optional(),
          rates: z
            .array(z.object({ name: z.string(), boardName: z.string().optional() }))
            .optional(),
        }),
      ),
    }),
  ),
  hotels: z
    .array(z.object({ id: z.string(), name: z.string(), rating: z.number().optional() }))
    .optional(),
});

const PrebookResponse = z.object({
  data: z.object({
    prebookId: z.string(),
    price: z.number(),
    currency: z.string(),
    priceDifferencePercent: z.number().optional(),
    roomTypes: z
      .array(
        z.object({
          rates: z.array(
            z.object({
              cancellationPolicies: z.object({ refundableTag: z.string().optional() }).optional(),
            }),
          ),
        }),
      )
      .optional(),
  }),
});

const BookResponse = z.object({
  data: z.object({
    bookingId: z.string(),
    status: z.string(),
    hotelConfirmationCode: z.string().optional().nullable(),
    hotel: z.object({ name: z.string() }).partial().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
  }),
});

export interface HotelOffer {
  offerId: string;
  hotelId: string;
  hotelName: string;
  roomName: string;
  board?: string;
  total: number;
  currency: string;
}

export interface HotelMatch {
  hotelId: string;
  name: string;
  score: number; // 0–1, how well it matches the query
  city?: string;
  locationType?: string; // e.g. "Beachfront Resort"
  tags: string[];
}

export interface HotelPrebook {
  prebookId: string;
  total: number; // final price for the stay
  currency: string;
  priceChangedPercent: number; // 0 unless the rate sold out and a similar one was substituted
  refundable?: boolean; // RFN vs NRFN, when the supplier says
}

export interface HotelGuest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface HotelBooking {
  bookingId: string;
  status: string;
  confirmationCode?: string;
  hotelName?: string;
  total?: number;
  currency?: string;
}

export class LiteApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertSandboxKey(apiKey);
  }

  private post(base: string, path: string, body: unknown): Promise<unknown> {
    return litePost(this.fetchImpl, this.apiKey, `${base}${path}`, body);
  }

  /** Hotels near an airport (IATA code), cheapest offer per hotel, cheapest first. */
  async searchHotels(q: {
    iataCode?: string; // hotels near this airport…
    hotelIds?: string[]; // …or exactly these hotels
    refundableOnly?: boolean; // only rates with free cancellation (RFN)
    checkin: string;
    checkout: string;
    adults: number;
    currency?: string;
    guestNationality?: string;
    limit?: number;
  }): Promise<HotelOffer[]> {
    if (!q.iataCode && !q.hotelIds?.length) throw new Error("Need iataCode or hotelIds");
    const json = await this.post(LITEAPI_URL, "/hotels/rates", {
      ...(q.hotelIds?.length ? { hotelIds: q.hotelIds } : { iataCode: q.iataCode }),
      checkin: q.checkin,
      checkout: q.checkout,
      occupancies: [{ adults: q.adults }],
      currency: q.currency ?? "INR",
      guestNationality: q.guestNationality ?? "IN",
      maxRatesPerHotel: 1,
      includeHotelData: true,
      ...(q.refundableOnly ? { refundableRatesOnly: true } : {}),
      limit: q.limit ?? 20,
    });
    const parsed = RatesResponse.parse(
      (json as { error?: unknown }).error ? { data: [], ...(json as object) } : json,
    );
    if (parsed.error && parsed.error.code !== 2001) {
      throw new Error(
        `LiteAPI /hotels/rates → ${parsed.error.code}: ${parsed.error.message ?? ""}`,
      );
    }
    const names = new Map((parsed.hotels ?? []).map((h) => [h.id, h.name]));
    return parsed.data
      .flatMap((h) =>
        h.roomTypes.slice(0, 1).map((rt): HotelOffer | null => {
          const price = Array.isArray(rt.offerRetailRate)
            ? rt.offerRetailRate[0]
            : rt.offerRetailRate;
          if (!price) return null;
          return {
            offerId: rt.offerId,
            hotelId: h.hotelId,
            hotelName: names.get(h.hotelId) ?? h.hotelId,
            roomName: rt.rates?.[0]?.name ?? rt.name ?? "Room",
            board: rt.rates?.[0]?.boardName,
            total: price.amount,
            currency: price.currency,
          };
        }),
      )
      .filter((o): o is HotelOffer => o !== null)
      .sort((a, b) => a.total - b.total);
  }

  /** Hotels that match a description by meaning ("quiet beachfront in Goa"), best match first. */
  async semanticSearch(query: string, limit = 10): Promise<HotelMatch[]> {
    const json = await liteGet(
      this.fetchImpl,
      this.apiKey,
      `${LITEAPI_URL}/data/hotels/semantic-search`,
      {
        query,
        limit,
      },
    );
    return SemanticResponse.parse(json)
      .data.map((h) => ({
        hotelId: h.id,
        name: h.name,
        score: h.score,
        city: h.city,
        locationType: h.location_type,
        tags: h.tags ?? [],
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Checks live availability and locks the final price (step 1 of 2). The prebook id is what
   * gets booked, so a quote built on it is firm. Reusable until it expires.
   */
  async prebook(offerId: string): Promise<HotelPrebook> {
    const json = await this.post(LITEAPI_BOOK_URL, "/rates/prebook", {
      offerId,
      usePaymentSdk: false,
    });
    const { data } = PrebookResponse.parse(json);
    const tag = data.roomTypes?.[0]?.rates[0]?.cancellationPolicies?.refundableTag;
    return {
      prebookId: data.prebookId,
      total: data.price,
      currency: data.currency,
      priceChangedPercent: data.priceDifferencePercent ?? 0,
      refundable: tag === undefined ? undefined : tag === "RFN",
    };
  }

  /** Confirms the booking with a simulated sandbox card (step 2 of 2). */
  async book(
    prebookId: string,
    guest: HotelGuest,
    clientReference?: string,
  ): Promise<HotelBooking> {
    const json = await this.post(LITEAPI_BOOK_URL, "/rates/book", {
      prebookId,
      clientReference,
      holder: guest,
      guests: [
        {
          occupancyNumber: 1,
          firstName: guest.firstName,
          lastName: guest.lastName,
          email: guest.email,
        },
      ],
      payment: { method: "ACC_CREDIT_CARD" },
    });
    const { data } = BookResponse.parse(json);
    return {
      bookingId: data.bookingId,
      status: data.status,
      confirmationCode: data.hotelConfirmationCode ?? undefined,
      hotelName: data.hotel?.name,
      total: data.price,
      currency: data.currency,
    };
  }
}
