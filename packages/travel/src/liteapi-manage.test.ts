import { describe, expect, it } from "vitest";
import { stubFetch } from "./fetch-stub";
import { cancellationFeeAt, LiteHotelBookings, type ManagedBooking } from "./liteapi-manage";

const booking = {
  data: {
    bookingId: "e_DvB6yTZ",
    status: "CONFIRMED",
    checkin: "2026-11-13",
    checkout: "2026-11-15",
    hotel: { hotelId: "lp3561a", name: "Park Inn by Radisson Goa Candolim" },
    bookedRooms: [
      {
        adults: 2,
        rate: {
          retailRate: { total: { amount: 17815.68, currency: "INR" } },
          cancellationPolicies: {
            cancelPolicyInfos: [
              { cancelTime: "2026-11-12 10:00:00", amount: 17815.68 },
              { cancelTime: "2026-10-29 10:00:00", amount: 17815.68 },
            ],
            refundableTag: "RFN",
          },
        },
      },
    ],
  },
};

describe("LiteHotelBookings", () => {
  it("refuses non-sandbox keys", () => {
    expect(() => new LiteHotelBookings("prod_x")).toThrow(/sandbox/);
  });

  it("reads a booking with its refund rules", async () => {
    const { fetchImpl, calls } = stubFetch({ "/bookings/e_DvB6yTZ": booking });
    const b = await new LiteHotelBookings("sand_x", fetchImpl).get("e_DvB6yTZ");
    expect(b).toMatchObject({
      hotelName: "Park Inn by Radisson Goa Candolim",
      total: 17815.68,
      currency: "INR",
      adults: 2,
      refundable: true,
    });
    expect(b.cancelFees[0]).toEqual({ after: "2026-10-29 10:00:00", amount: 17815.68 });
    expect(calls[0]?.method).toBe("GET");
  });

  it("works out what cancelling costs right now", () => {
    const b: ManagedBooking = {
      bookingId: "b",
      status: "CONFIRMED",
      checkin: "",
      checkout: "",
      total: 100,
      refundable: true,
      cancelFees: [{ after: "2026-10-29 10:00:00", amount: 100 }],
    };
    expect(cancellationFeeAt(b, new Date("2026-10-22T00:00:00Z"))).toBe(0);
    expect(cancellationFeeAt(b, new Date("2026-10-30T00:00:00Z"))).toBe(100);
    expect(cancellationFeeAt({ ...b, refundable: false }, new Date("2026-10-22T00:00:00Z"))).toBe(
      100,
    );
  });

  it("gets locked options for new dates, cheapest first", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/alternative-prebooks": {
        data: [
          {
            prebookId: "p2",
            price: 29276.98,
            currency: "INR",
            priceDifferencePercent: 64,
            checkin: "2026-11-13",
            checkout: "2026-11-16",
          },
          {
            prebookId: "p1",
            price: 28767.44,
            currency: "INR",
            priceDifferencePercent: 61,
            checkin: "2026-11-13",
            checkout: "2026-11-16",
            roomTypes: [{ rates: [{ cancellationPolicies: { refundableTag: "RFN" } }] }],
          },
        ],
      },
    });
    const opts = await new LiteHotelBookings("sand_x", fetchImpl).changeOptions("e_DvB6yTZ", {
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      adults: 2,
    });
    expect(opts.map((o) => o.prebookId)).toEqual(["p1", "p2"]);
    expect(opts[0]).toMatchObject({ priceDifferencePercent: 61, refundable: true });
    expect(calls[0]?.body).toEqual({
      occupancies: [{ adults: 2 }],
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      maxPrebooks: 3,
    });
  });

  it("rebooks (old booking cancelled by LiteAPI), or reports a queued change", async () => {
    const guest = { firstName: "Asha", lastName: "Traveller", email: "a@example.com" };
    const ok = stubFetch({
      "/rates/rebook": {
        data: { bookingId: "x8DfmhWpo", status: "CONFIRMED", price: 28767.44, currency: "INR" },
      },
    });
    expect(
      await new LiteHotelBookings("sand_x", ok.fetchImpl).rebook("p1", "e_DvB6yTZ", guest),
    ).toEqual({
      queued: false,
      bookingId: "x8DfmhWpo",
      status: "CONFIRMED",
      total: 28767.44,
      currency: "INR",
    });
    expect(ok.calls[0]?.body).toMatchObject({
      prebookId: "p1",
      existingBookingId: "e_DvB6yTZ",
      payment: { method: "NONE" },
    });
    const queued = stubFetch({
      "/rates/rebook": {
        __status: 202,
        body: { data: { id: 1234, bookingId: "NEW", status: "PENDING" } },
      },
    });
    expect(
      await new LiteHotelBookings("sand_x", queued.fetchImpl).rebook("p1", "e_DvB6yTZ", guest),
    ).toEqual({
      queued: true,
      amendmentId: 1234,
      status: "PENDING",
    });
  });

  it("changes the lead guest and cancels", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/amend": { id: 3659, status: "PENDING" },
      "/bookings/x8DfmhWpo": {
        data: {
          bookingId: "x8DfmhWpo",
          status: "CANCELLED",
          cancellation_fee: 0,
          refund_amount: 28767.44,
          currency: "INR",
        },
      },
    });
    const m = new LiteHotelBookings("sand_x", fetchImpl);
    expect(
      await m.amendHolder("x8DfmhWpo", {
        firstName: "Rohan",
        lastName: "Traveller",
        email: "r@example.com",
      }),
    ).toEqual({
      amendmentId: 3659,
      status: "PENDING",
    });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { holder: { firstName: "Rohan" } } });
    expect(await m.cancel("x8DfmhWpo")).toEqual({
      status: "CANCELLED",
      fee: 0,
      refund: 28767.44,
      currency: "INR",
    });
    expect(calls[1]?.method).toBe("PUT");
  });
});
