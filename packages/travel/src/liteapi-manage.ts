import { z } from "zod";
import { assertSandboxKey, LITEAPI_BOOK_URL, liteGet, liteSend } from "./liteapi-http";

/**
 * Managing hotel bookings after they're made (LiteAPI sandbox): look up, change dates or guests
 * (alternative prebooks → rebook; the old booking is cancelled automatically), change the lead
 * guest's name, cancel. Docs: https://docs.liteapi.travel/reference/put_bookings-bookingid
 */

const Policies = z
  .object({
    cancelPolicyInfos: z
      .array(z.object({ cancelTime: z.string(), amount: z.number() }))
      .optional()
      .nullable(),
    refundableTag: z.string().optional(),
  })
  .optional()
  .nullable();

const BookingResponse = z.object({
  data: z.object({
    bookingId: z.string(),
    status: z.string(),
    checkin: z.string(),
    checkout: z.string(),
    hotel: z.object({ hotelId: z.string().optional(), name: z.string() }).partial().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    holder: z
      .object({ firstName: z.string(), lastName: z.string(), email: z.string() })
      .partial()
      .optional()
      .nullable(),
    bookedRooms: z
      .array(
        z.object({
          adults: z.number().optional(),
          rate: z
            .object({
              retailRate: z
                .object({ total: z.object({ amount: z.number(), currency: z.string() }) })
                .partial()
                .optional(),
              cancellationPolicies: Policies,
            })
            .partial()
            .optional(),
        }),
      )
      .optional(),
  }),
});

const AlternativesResponse = z.object({
  data: z.array(
    z.object({
      prebookId: z.string(),
      price: z.number(),
      currency: z.string(),
      priceDifferencePercent: z.number().optional(),
      checkin: z.string(),
      checkout: z.string(),
      roomTypes: z
        .array(z.object({ rates: z.array(z.object({ cancellationPolicies: Policies })) }))
        .optional(),
    }),
  ),
});

const RebookResponse = z.object({
  data: z.object({
    bookingId: z.string(),
    status: z.string(),
    checkin: z.string().optional(),
    checkout: z.string().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    id: z.number().optional(), // amendment id, when queued (202)
  }),
});

const AmendResponse = z.object({ id: z.number(), status: z.string().optional() });

const CancelResponse = z.object({
  data: z.object({
    bookingId: z.string(),
    status: z.string(),
    cancellation_fee: z.number().optional(),
    refund_amount: z.number().optional(),
    currency: z.string(),
  }),
});

export interface ManagedBooking {
  bookingId: string;
  status: string; // CONFIRMED, CANCELLED, …
  hotelName?: string;
  checkin: string;
  checkout: string;
  adults?: number;
  holder?: { firstName?: string; lastName?: string; email?: string };
  total?: number;
  currency?: string;
  refundable?: boolean;
  /** Charges that apply if cancelled after each time (GMT). Empty = free to cancel. */
  cancelFees: { after: string; amount: number }[];
}

export interface ChangeOption {
  prebookId: string;
  total: number;
  currency: string;
  priceDifferencePercent: number; // vs what was paid: negative = cheaper
  checkin: string;
  checkout: string;
  refundable?: boolean;
}

export type RebookResult =
  | { queued: false; bookingId: string; status: string; total?: number; currency?: string }
  | { queued: true; amendmentId?: number; status: string }; // non-refundable original: handled by hand

export interface CancelResult {
  status: string; // CANCELLED or CANCELLED_WITH_CHARGES
  fee: number;
  refund: number;
  currency: string;
}

export class LiteHotelBookings {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertSandboxKey(apiKey);
  }

  async get(bookingId: string): Promise<ManagedBooking> {
    const url = `${LITEAPI_BOOK_URL}/bookings/${encodeURIComponent(bookingId)}`;
    const { data } = BookingResponse.parse(await liteGet(this.fetchImpl, this.apiKey, url, {}));
    const room = data.bookedRooms?.[0];
    const policies = room?.rate?.cancellationPolicies;
    return {
      bookingId: data.bookingId,
      status: data.status,
      hotelName: data.hotel?.name,
      checkin: data.checkin,
      checkout: data.checkout,
      adults: room?.adults,
      holder: data.holder ?? undefined,
      total: data.price ?? room?.rate?.retailRate?.total?.amount,
      currency: data.currency ?? room?.rate?.retailRate?.total?.currency,
      refundable: policies?.refundableTag ? policies.refundableTag === "RFN" : undefined,
      cancelFees: (policies?.cancelPolicyInfos ?? [])
        .filter((p) => p.amount > 0)
        .map((p) => ({ after: p.cancelTime, amount: p.amount }))
        .sort((a, b) => a.after.localeCompare(b.after)),
    };
  }

  /** Locked options at the same hotel for new dates / guests, cheapest first. */
  async changeOptions(
    bookingId: string,
    q: { checkin: string; checkout: string; adults: number; max?: number },
  ): Promise<ChangeOption[]> {
    const url = `${LITEAPI_BOOK_URL}/bookings/${encodeURIComponent(bookingId)}/alternative-prebooks`;
    const json = await liteSend(this.fetchImpl, this.apiKey, "POST", url, {
      occupancies: [{ adults: q.adults }],
      checkin: q.checkin,
      checkout: q.checkout,
      maxPrebooks: q.max ?? 3,
    });
    return AlternativesResponse.parse(json)
      .data.map((a) => {
        const tag = a.roomTypes?.[0]?.rates[0]?.cancellationPolicies?.refundableTag;
        return {
          prebookId: a.prebookId,
          total: a.price,
          currency: a.currency,
          priceDifferencePercent: a.priceDifferencePercent ?? 0,
          checkin: a.checkin,
          checkout: a.checkout,
          refundable: tag ? tag === "RFN" : undefined,
        };
      })
      .sort((x, y) => x.total - y.total);
  }

  /** Books the chosen option; LiteAPI cancels the original booking itself. */
  async rebook(
    prebookId: string,
    existingBookingId: string,
    guest: { firstName: string; lastName: string; email: string },
  ): Promise<RebookResult> {
    let status = 200;
    const json = await liteSend(
      this.fetchImpl,
      this.apiKey,
      "POST",
      `${LITEAPI_BOOK_URL}/rates/rebook`,
      {
        prebookId,
        existingBookingId,
        holder: {},
        guests: [{ occupancyNumber: 1, ...guest }],
        payment: { method: "NONE" },
      },
      (s) => {
        status = s;
      },
    );
    const { data } = RebookResponse.parse(json);
    if (status === 202) return { queued: true, amendmentId: data.id, status: data.status };
    return {
      queued: false,
      bookingId: data.bookingId,
      status: data.status,
      total: data.price,
      currency: data.currency,
    };
  }

  /** Changes the lead guest's name/email. Creates a request LiteAPI processes (not instant). */
  async amendHolder(
    bookingId: string,
    holder: { firstName: string; lastName: string; email: string },
  ): Promise<{ amendmentId: number; status: string }> {
    const url = `${LITEAPI_BOOK_URL}/bookings/${encodeURIComponent(bookingId)}/amend`;
    const json = await liteSend(this.fetchImpl, this.apiKey, "PUT", url, { holder });
    const r = AmendResponse.parse(json);
    return { amendmentId: r.id, status: r.status ?? "PENDING" };
  }

  async cancel(bookingId: string): Promise<CancelResult> {
    const url = `${LITEAPI_BOOK_URL}/bookings/${encodeURIComponent(bookingId)}`;
    const { data } = CancelResponse.parse(await liteSend(this.fetchImpl, this.apiKey, "PUT", url));
    return {
      status: data.status,
      fee: data.cancellation_fee ?? 0,
      refund: data.refund_amount ?? 0,
      currency: data.currency,
    };
  }
}

/** What cancelling would cost at `now`: the charge of the latest deadline already passed. */
export function cancellationFeeAt(b: ManagedBooking, now: Date): number {
  if (b.refundable === false) return b.total ?? 0;
  const iso = now.toISOString().replace("T", " ").slice(0, 19);
  const passed = b.cancelFees.filter((f) => f.after <= iso);
  return passed.length ? Math.max(...passed.map((f) => f.amount)) : 0;
}
