import { describe, expect, it } from "vitest";
import { DuffelClient } from "./duffel";
import { stubFetch as stub } from "./fetch-stub";

const segment = (origin: string, dest: string, day = "13") => ({
  departing_at: `2026-11-${day}T19:00:00`,
  arriving_at: `2026-11-${day}T20:10:00`,
  origin: { iata_code: origin },
  destination: { iata_code: dest },
  marketing_carrier: { name: "Duffel Airways", iata_code: "ZZ" },
  marketing_carrier_flight_number: "0421",
});

describe("DuffelClient", () => {
  it("refuses non-test tokens", () => {
    expect(() => new DuffelClient("duffel_live_abc")).toThrow(/test-mode/);
  });

  it("searches and returns offers cheapest first", async () => {
    const { fetchImpl, calls } = stub({
      "/air/offer_requests": {
        data: {
          passengers: [{ id: "pas_1" }],
          offers: [
            {
              id: "off_b",
              total_amount: "90.00",
              total_currency: "USD",
              slices: [{ segments: [segment("BOM", "GOI")] }],
            },
            {
              id: "off_a",
              total_amount: "45.00",
              total_currency: "USD",
              slices: [{ segments: [segment("BOM", "GOI")] }],
            },
          ],
        },
      },
    });
    const offers = await new DuffelClient("duffel_test_x", fetchImpl).searchFlights({
      origin: "BOM",
      destination: "GOI",
      date: "2026-11-13",
      adults: 1,
    });
    expect(offers.map((o) => o.offerId)).toEqual(["off_a", "off_b"]);
    expect(offers[0]).toMatchObject({
      outbound: { carrier: "Duffel Airways", flightNumber: "ZZ0421", stops: 0 },
      passengerIds: ["pas_1"],
    });
    expect(offers[0]?.inbound).toBeUndefined();
    expect(calls[0]?.headers.get("Duffel-Version")).toBe("v2");
  });

  it("asks for a return slice and keeps only offers that include it", async () => {
    const { fetchImpl, calls } = stub({
      "/air/offer_requests": {
        data: {
          passengers: [{ id: "pas_1" }, { id: "pas_2" }],
          offers: [
            {
              id: "off_rt",
              total_amount: "176.84",
              total_currency: "GBP",
              slices: [
                { segments: [segment("BOM", "GOI", "13")] },
                { segments: [segment("GOI", "BLR", "15"), segment("BLR", "BOM", "15")] },
              ],
            },
            {
              id: "off_oneway_only",
              total_amount: "50.00",
              total_currency: "GBP",
              slices: [{ segments: [segment("BOM", "GOI")] }],
            },
          ],
        },
      },
    });
    const offers = await new DuffelClient("duffel_test_x", fetchImpl).searchFlights({
      origin: "BOM",
      destination: "GOI",
      date: "2026-11-13",
      returnDate: "2026-11-15",
      adults: 2,
    });
    expect(offers.map((o) => o.offerId)).toEqual(["off_rt"]);
    expect(offers[0]?.inbound).toMatchObject({ origin: "GOI", destination: "BOM", stops: 1 });
    expect(calls[0]?.body).toMatchObject({
      data: {
        slices: [
          { origin: "BOM", destination: "GOI", departure_date: "2026-11-13" },
          { origin: "GOI", destination: "BOM", departure_date: "2026-11-15" },
        ],
        passengers: [{ type: "adult" }, { type: "adult" }],
      },
    });
  });

  it("books an instant order paid from balance", async () => {
    const { fetchImpl, calls } = stub({
      "/air/orders": {
        data: {
          id: "ord_1",
          booking_reference: "ABC123",
          total_amount: "45.00",
          total_currency: "USD",
        },
      },
    });
    const offer = {
      offerId: "off_a",
      passengerIds: ["pas_1"],
      outbound: {
        carrier: "Duffel Airways",
        origin: "BOM",
        destination: "GOI",
        departAt: "",
        arriveAt: "",
        stops: 0,
      },
      total: "45.00",
      currency: "USD",
    };
    const booking = await new DuffelClient("duffel_test_x", fetchImpl).bookFlight(offer, [
      {
        title: "mr",
        givenName: "Rohan",
        familyName: "Traveller",
        gender: "m",
        bornOn: "1991-02-15",
        nationality: "IN",
        email: "traveller2@example.com",
        phoneCountryCode: "91",
        phone: "9876543201",
      },
    ]);
    expect(booking.bookingReference).toBe("ABC123");
    expect(calls[0]?.body).toMatchObject({
      data: {
        type: "instant",
        selected_offers: ["off_a"],
        payments: [{ type: "balance", amount: "45.00", currency: "USD" }],
        passengers: [{ id: "pas_1", given_name: "Rohan", phone_number: "+919876543201" }],
      },
    });
  });
});
