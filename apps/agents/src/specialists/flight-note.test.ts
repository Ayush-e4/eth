import { describe, expect, it } from "vitest";
import { describeItinerary, describeLeg } from "./flight-note";

const leg = (from: string, to: string, at: string, stops = 0) => ({
  carrier: "IndiGo",
  flightNumber: "6E5321",
  origin: from,
  destination: to,
  departAt: at,
  arriveAt: at,
  stops,
});

describe("flight notes", () => {
  it("describes one leg", () => {
    expect(describeLeg(leg("BOM", "GOI", "2026-10-30T07:10:00"))).toBe(
      "IndiGo 6E5321 BOM→GOI 30 Oct 07:10, nonstop",
    );
  });

  it("describes a round trip with both legs and one price", () => {
    const note = describeItinerary(
      {
        outbound: leg("BOM", "GOI", "2026-10-30T07:10:00"),
        inbound: leg("GOI", "BOM", "2026-11-01T19:45:00", 1),
      },
      "12,617.85 INR",
    );
    expect(note).toBe(
      "IndiGo 6E5321 BOM→GOI 30 Oct 07:10, nonstop · return IndiGo 6E5321 GOI→BOM 1 Nov 19:45, 1 stop — 12,617.85 INR round trip",
    );
  });
});
