import { describe, expect, it } from "vitest";
import { stubFetch } from "./fetch-stub";
import { type LiteFlightOffer, LiteFlightsClient } from "./liteapi-flights";
import type { Traveller } from "./types";

const segment = (direction: string, from: string, to: string) => ({
  originCode: from,
  destinationCode: to,
  departureTime: "2026-11-06T07:10:00",
  arrivalTime: "2026-11-06T08:25:00",
  direction,
  flight: { marketingNumber: "5321" },
  carrier: { marketingCode: "6E", marketingName: "IndiGo" },
});
const offer = (offerId: string, total: number) => ({
  offerId,
  pricing: { display: { total, currency: "INR" } },
  provider: { code: "E2E" },
});

const traveller: Traveller = {
  title: "ms",
  givenName: "Asha",
  familyName: "Traveller",
  gender: "f",
  bornOn: "1990-01-15",
  nationality: "IN",
  email: "traveller1@example.com",
  phoneCountryCode: "91",
  phone: "9876543200",
};

describe("LiteFlightsClient", () => {
  it("refuses non-sandbox keys", () => {
    expect(() => new LiteFlightsClient("prod_abc")).toThrow(/sandbox/);
  });

  it("searches one way and returns every offer cheapest first", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/flights/rates": {
        data: [
          {
            journeys: [
              {
                segments: [segment("OUTBOUND", "BOM", "GOI")],
                offers: [offer("o_mid", 5400), offer("o_high", 7200)],
              },
              {
                segments: [segment("OUTBOUND", "BOM", "BLR"), segment("OUTBOUND", "BLR", "GOI")],
                offers: [offer("o_low", 4100)],
              },
            ],
          },
        ],
      },
    });
    const offers = await new LiteFlightsClient("sand_x", fetchImpl).searchFlights({
      origin: "BOM",
      destination: "GOI",
      date: "2026-11-06",
      adults: 2,
    });
    expect(offers.map((o) => o.offerId)).toEqual(["o_low", "o_mid", "o_high"]);
    expect(offers[0]).toMatchObject({ origin: "BOM", destination: "GOI", stops: 1, total: 4100 });
    expect(offers[1]).toMatchObject({ carrier: "IndiGo", flightNumber: "6E5321", stops: 0 });
    expect(calls[0]?.headers.get("X-API-Key")).toBe("sand_x");
    expect(calls[0]?.body).toMatchObject({
      legs: [{ origin: "BOM", destination: "GOI", date: "2026-11-06" }],
      adults: 2,
      currency: "INR",
    });
  });

  it("prebooks with passenger + contact details, then books with the sandbox card", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/flights/prebooks": { data: [{ prebookId: "pb_1", transactionId: "tr_1" }] },
      "/flights/bookings": {
        data: [
          {
            booking: {
              bookingId: "bk_1",
              bookingRef: "NUI123",
              status: "CONFIRMED",
              order: { reference: { airlineBookings: [{ airlinePnr: "PNR9" }] } },
            },
          },
        ],
      },
    });
    const picked = { offerId: "o_low", total: 4100, currency: "INR" } as LiteFlightOffer;
    const booking = await new LiteFlightsClient("sand_x", fetchImpl).book(picked, [traveller]);

    expect(booking).toEqual({
      bookingId: "bk_1",
      bookingRef: "NUI123",
      airlinePnr: "PNR9",
      status: "CONFIRMED",
    });
    expect(calls[0]?.body).toMatchObject({
      offerId: "o_low",
      usePaymentSdk: false,
      contact: { firstName: "Asha", phoneCountryCode: "91", phoneNumber: "9876543200" },
      passengers: [{ title: "MS", gender: "F", birthday: "1990-01-15", passengerType: 0 }],
    });
    expect(calls[1]?.body).toEqual({ prebookId: "pb_1", payment: { method: "ACC_CREDIT_CARD" } });
  });
});
