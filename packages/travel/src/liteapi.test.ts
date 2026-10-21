import { describe, expect, it } from "vitest";
import { stubFetch as stub } from "./fetch-stub";
import { LiteApiClient } from "./liteapi";

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
                offerRetailRate: { amount: 9000, currency: "INR" }, // real sandbox shape
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

  it("finds hotels by meaning, then prices exactly those hotels", async () => {
    const { fetchImpl, calls } = stub({
      "/data/hotels/semantic-search": {
        data: [
          { id: "h2", name: "Bogmallo Beach", score: 0.86, location_type: "Coastal Resort" },
          { id: "h1", name: "Agonda Serenity", score: 0.91, location_type: "Beach Resort" },
        ],
      },
      "/hotels/rates": { data: [], hotels: [] },
    });
    const c = new LiteApiClient("sand_x", fetchImpl);
    const matches = await c.semanticSearch("quiet beachfront hotel in Goa", 5);
    expect(matches.map((m) => m.hotelId)).toEqual(["h1", "h2"]);
    expect(matches[0]).toMatchObject({ score: 0.91, locationType: "Beach Resort" });
    expect(calls[0]?.url).toContain("query=quiet+beachfront+hotel+in+Goa");
    expect(calls[0]?.url).toContain("limit=5");
    await c.searchHotels({
      hotelIds: ["h1", "h2"],
      checkin: "2026-10-30",
      checkout: "2026-11-01",
      adults: 2,
    });
    expect(calls[1]?.body).toMatchObject({ hotelIds: ["h1", "h2"] });
    expect(calls[1]?.body).not.toHaveProperty("iataCode");
  });

  it("prebooks then books with the sandbox card", async () => {
    const { fetchImpl, calls } = stub({
      "/rates/prebook": {
        data: {
          prebookId: "pb_1",
          price: 9488.39,
          currency: "INR",
          priceDifferencePercent: 0,
          roomTypes: [{ rates: [{ cancellationPolicies: { refundableTag: "RFN" } }] }],
        },
      },
      "/rates/book": {
        data: { bookingId: "bk_1", status: "CONFIRMED", hotelConfirmationCode: "HC9" },
      },
    });
    const c = new LiteApiClient("sand_x", fetchImpl);
    const prebook = await c.prebook("o1");
    expect(prebook).toEqual({
      prebookId: "pb_1",
      total: 9488.39,
      currency: "INR",
      priceChangedPercent: 0,
      refundable: true,
    });
    const booking = await c.book(prebook.prebookId, {
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
