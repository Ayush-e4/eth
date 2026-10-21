import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trip";
import { askStructured } from "./claude";
import { calendar, checkTripDates, planTrip } from "./plan";

vi.mock("./claude", () => ({ askStructured: vi.fn() }));

// Thursday 22 Oct 2026, 10:00 in India
const today = new Date("2026-10-22T04:30:00Z");
const trip = (departDate: string, returnDate: string): Trip => ({
  origin: "BOM",
  destination: "GOI",
  destinationName: "Goa",
  departDate,
  returnDate,
  returnFlight: true,
  hotelWishes: "",
  adults: 2,
  budgetInr: 40000,
  notes: "",
});

beforeEach(() => vi.clearAllMocks());

describe("trip planning dates", () => {
  it("gives Claude a calendar of real weekdays in India time", () => {
    const c = calendar(today, 3);
    expect(c).toBe("Thu 2026-10-22 (today), Fri 2026-10-23, Sat 2026-10-24");
  });

  it("uses India's date even when it's still yesterday in UTC", () => {
    expect(calendar(new Date("2026-10-21T20:00:00Z"), 1)).toBe("Thu 2026-10-22 (today)");
  });

  it("rejects departures today or earlier, and returns before departure", () => {
    expect(checkTripDates(trip("2026-10-22", "2026-10-25"), today)).toContain("not after today");
    expect(checkTripDates(trip("2026-10-23", "2026-10-23"), today)).toContain("must be after");
    expect(checkTripDates(trip("2026-10-23", "2026-10-25"), today)).toBeNull();
  });

  it("asks Claude once more with the problem when the dates are wrong", async () => {
    vi.mocked(askStructured)
      .mockResolvedValueOnce(trip("2026-10-22", "2026-10-25"))
      .mockResolvedValueOnce(trip("2026-10-23", "2026-10-25"));
    const t = await planTrip("Goa next Friday till Sunday", today);
    expect(t.departDate).toBe("2026-10-23");
    expect(askStructured).toHaveBeenCalledTimes(2);
    expect(vi.mocked(askStructured).mock.calls[1]?.[0].user).toContain(
      "departDate 2026-10-22 is not after today",
    );
  });

  it("gives up after a second bad answer instead of booking wrong dates", async () => {
    vi.mocked(askStructured).mockResolvedValue(trip("2026-10-20", "2026-10-21"));
    await expect(planTrip("Goa", today)).rejects.toThrow("Could not plan valid dates");
  });
});
