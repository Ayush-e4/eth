import { describe, expect, it, vi } from "vitest";
import type { MarketAgent } from "./market";
import { marketSummary, matchAgents } from "./match";

const agent = (name: string, skill: string, title: string, description: string) =>
  ({
    name,
    skill,
    title,
    description,
    priceUnits: "10000",
    agent: "0x1",
    endpoint: "",
  }) as MarketAgent;
const market = [
  agent("SkyHop", "flights", "SkyHop — cheapest flight, booked via Duffel", "Books flights."),
  agent("StayWise", "hotels", "StayWise — best-value hotel", "Finds and books hotels."),
  agent("PackPal", "packing", "PackPal — packing lists", "Makes a packing list for your trip."),
  agent("Spotless", "laundry", "Spotless — laundry pickup", "Picks up and washes your clothes."),
];

describe("matching agents by what they do", () => {
  it("finds agents by the user's words, skill first, then title and description", () => {
    expect(matchAgents(market, "help me pack for Goa").map((a) => a.name)).toEqual(["PackPal"]);
    expect(matchAgents(market, "a hotel near the beach").map((a) => a.name)).toEqual(["StayWise"]);
    expect(matchAgents(market, "someone to wash my clothes").map((a) => a.name)).toEqual([
      "Spotless",
    ]);
    expect(matchAgents(market, "the a to")).toEqual([]); // nothing to match on
  });

  it("sums up the market per skill for the concierge, cached", async () => {
    const agents = vi.fn(async () => market);
    const summary = marketSummary({ agents });
    const text = await summary();
    expect(text).toContain("- flights: SkyHop (cheapest flight, booked via Duffel)");
    expect(text).toContain("- laundry: Spotless (laundry pickup)");
    await summary();
    expect(agents).toHaveBeenCalledOnce();
  });
});
