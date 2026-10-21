import type { HotelOffer, LiteApiClient } from "@eth/travel";
import { describe, expect, it, vi } from "vitest";
import type { TaskBody } from "../trip";
import { staywise } from "./staywise";

const offer = (offerId: string, hotelName: string, total: number): HotelOffer => ({
  offerId,
  hotelId: offerId,
  hotelName,
  roomName: "Standard",
  board: "Breakfast Included",
  total,
  currency: "INR",
});
const body = {
  task: "trip-goi-1",
  trip: {
    origin: "BOM",
    destination: "GOI",
    destinationName: "Goa",
    departDate: "2026-10-23",
    returnDate: "2026-10-25",
    returnFlight: true,
    nonRefundableOk: false,
    hotelWishes: "",
    adults: 2,
    budgetInr: null,
    notes: "",
  },
} satisfies TaskBody;

function fakeLite(
  prebook: LiteApiClient["prebook"],
  matches: Awaited<ReturnType<LiteApiClient["semanticSearch"]>> = [],
) {
  return {
    semanticSearch: vi.fn(async () => matches),
    searchHotels: vi.fn(async () => [
      offer("o1", "Park Inn", 9000),
      offer("o2", "Fairfield", 9500),
    ]),
    prebook: vi.fn(prebook),
    book: vi.fn(async (prebookId: string) => ({
      bookingId: `bk_${prebookId}`,
      status: "CONFIRMED",
    })),
  };
}

describe("StayWise firm quotes", () => {
  it("locks the price before quoting and quotes the locked price", async () => {
    const lite = fakeLite(async () => ({
      prebookId: "pb_1",
      total: 9120.5,
      currency: "INR",
      priceChangedPercent: 1,
      refundable: true,
    }));
    const q = await staywise(lite as never).quote(body);
    expect(q).toMatchObject({ itemTotal: 9120.5, itemCurrency: "INR" });
    expect(q.note).toBe(
      "Park Inn — Standard, Breakfast Included, free cancellation, 9,120.5 INR total (price locked)",
    );
    const booking = await staywise(lite as never).work(body, q.detail);
    expect(lite.book).toHaveBeenCalledWith("pb_1", expect.anything(), "trip-goi-1");
    expect(booking).toMatchObject({ bookingId: "bk_pb_1" });
  });

  it("falls back to the next-cheapest room when one can't be locked", async () => {
    const lite = fakeLite(async (offerId) => {
      if (offerId === "o1") throw new Error("no prebook availability");
      return { prebookId: "pb_2", total: 9500, currency: "INR", priceChangedPercent: 0 };
    });
    const q = await staywise(lite as never).quote(body);
    expect(q.note).toContain("Fairfield");
    expect(q.detail.prebook.prebookId).toBe("pb_2");
  });

  it("refuses to quote (so nobody pays) when no room can be locked", async () => {
    const lite = fakeLite(async () => {
      throw new Error("no prebook availability");
    });
    await expect(staywise(lite as never).quote(body)).rejects.toThrow("Couldn't lock any");
  });
});

describe("StayWise with the traveller's hotel wishes", () => {
  const wishful = { ...body, trip: { ...body.trip, hotelWishes: "quiet, beachfront" } };
  const locked = async () => ({
    prebookId: "pb_w",
    total: 8043,
    currency: "INR",
    priceChangedPercent: 0,
    refundable: false,
  });
  const match = (hotelId: string, name: string, score: number) => ({
    hotelId,
    name,
    score,
    locationType: "Beachfront Resort",
    tags: [],
  });

  it("prices only strong matches from search-by-meaning and says why it fits", async () => {
    const lite = fakeLite(locked, [
      match("o1", "Dunhill Beach Resort", 0.77),
      match("o9", "Lotus Sutra", 0.53),
    ]);
    const q = await staywise(lite as never).quote(wishful);
    expect(lite.semanticSearch).toHaveBeenCalledWith("quiet, beachfront hotel in Goa", 12);
    expect(lite.searchHotels).toHaveBeenCalledWith(expect.objectContaining({ hotelIds: ["o1"] }));
    expect(q.note).toContain('matches "quiet, beachfront" (Beachfront Resort, 0.77)');
  });

  it("falls back to the cheapest near the airport — and says so — when no match has rooms", async () => {
    const lite = fakeLite(locked, []);
    const q = await staywise(lite as never).quote(wishful);
    expect(lite.searchHotels).toHaveBeenCalledWith(expect.objectContaining({ iataCode: "GOI" }));
    expect(q.note).toContain('no hotel matching "quiet, beachfront" had rooms; cheapest instead');
  });
});
