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
    adults: 2,
    budgetInr: null,
    notes: "",
  },
} satisfies TaskBody;

function fakeLite(prebook: LiteApiClient["prebook"]) {
  return {
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
