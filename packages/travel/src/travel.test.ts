import { describe, expect, it } from "vitest";
import { DuffelClient } from "./duffel";
import { LiteApiClient } from "./liteapi";

/** fetch stub that records requests and answers with canned JSON per URL fragment. */
function stub(routes: Record<string, unknown>) {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "null")),
      headers: new Headers(init?.headers),
    });
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    return hit ? Response.json(hit[1]) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const segment = (origin: string, dest: string) => ({
  departing_at: "2026-11-13T19:00:00",
  arriving_at: "2026-11-13T20:10:00",
  origin: { iata_code: origin },
  destination: { iata_code: dest },
  marketing_carrier: { name: "Duffel Airways" },
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
      carrier: "Duffel Airways",
      stops: 0,
      passengerIds: ["pas_1"],
    });
    expect(calls[0]?.headers.get("Duffel-Version")).toBe("v2");
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
      carrier: "ZZ",
      origin: "BOM",
      destination: "GOI",
      departAt: "",
      arriveAt: "",
      stops: 0,
      total: "45.00",
      currency: "USD",
    };
    const booking = await new DuffelClient("duffel_test_x", fetchImpl).bookFlight(offer, [
      {
        title: "mr",
        givenName: "Ayush",
        familyName: "K",
        gender: "m",
        bornOn: "2000-01-01",
        email: "a@example.com",
        phone: "+919876543210",
      },
    ]);
    expect(booking.bookingReference).toBe("ABC123");
    expect(calls[0]?.body).toMatchObject({
      data: {
        type: "instant",
        selected_offers: ["off_a"],
        payments: [{ type: "balance", amount: "45.00" }],
      },
    });
  });
});

describe("LiteApiClient", () => {
  it("refuses non-sandbox keys", () => {
    expect(() => new LiteApiClient("prod_abc")).toThrow(/sandbox/);
  });

  it("searches near an airport and names hotels", async () => {
    const { fetchImpl, calls } = stub({
      "/hotels/rates": {
        data: [
          {
            hotelId: "h2",
            roomTypes: [
              {
                offerId: "o2",
                offerRetailRate: [{ amount: 9000, currency: "INR" }],
                rates: [{ name: "Deluxe" }],
              },
            ],
          },
          {
            hotelId: "h1",
            roomTypes: [
              {
                offerId: "o1",
                offerRetailRate: [{ amount: 6000, currency: "INR" }],
                rates: [{ name: "Standard", boardName: "Breakfast" }],
              },
            ],
          },
        ],
        hotels: [
          { id: "h1", name: "Baga Beach Stay" },
          { id: "h2", name: "Fort Aguada Inn" },
        ],
      },
    });
    const offers = await new LiteApiClient("sand_x", fetchImpl).searchHotels({
      iataCode: "GOI",
      checkin: "2026-11-13",
      checkout: "2026-11-15",
      adults: 2,
    });
    expect(offers[0]).toMatchObject({
      offerId: "o1",
      hotelName: "Baga Beach Stay",
      total: 6000,
      board: "Breakfast",
    });
    expect(calls[0]?.headers.get("X-API-Key")).toBe("sand_x");
    expect(calls[0]?.body).toMatchObject({ iataCode: "GOI", occupancies: [{ adults: 2 }] });
  });

  it("prebooks then books with the sandbox card", async () => {
    const { fetchImpl, calls } = stub({
      "/rates/prebook": { data: { prebookId: "pb_1" } },
      "/rates/book": {
        data: { bookingId: "bk_1", status: "CONFIRMED", hotelConfirmationCode: "HC9" },
      },
    });
    const c = new LiteApiClient("sand_x", fetchImpl);
    const prebookId = await c.prebook("o1");
    const booking = await c.book(prebookId, {
      firstName: "Ayush",
      lastName: "K",
      email: "a@example.com",
      phone: "+919876543210",
    });
    expect(booking).toMatchObject({
      bookingId: "bk_1",
      status: "CONFIRMED",
      confirmationCode: "HC9",
    });
    expect(calls[1]?.body).toMatchObject({
      prebookId: "pb_1",
      payment: { method: "ACC_CREDIT_CARD" },
    });
  });
});
