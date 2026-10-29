import { describe, expect, it } from "vitest";
import { withCardNotes } from "./card-notes";

describe("card notes in the concierge's history", () => {
  it("marks each card as an app record of what a tool did", () => {
    const text = withCardNotes("Cheapest is AirNest.", [
      {
        type: "quotes",
        skill: "flights",
        quotes: [
          {
            key: "q1",
            title: "AirNest",
            note: "IX1163",
            feeUnits: "30000",
            totalInr: 3805,
            best: true,
          },
        ],
      } as never,
      {
        type: "approval",
        code: "abc123",
        title: "Hire AirNest",
        detail: "IX1163",
        feeUnits: "30000",
      },
    ]);
    expect(text.split("\n")).toEqual([
      "Cheapest is AirNest.",
      "[app: get_quotes returned real quotes for flights: q1 AirNest ₹3805 fee 0.03 USDC — IX1163]",
      "[app: hire_agent asked the user to approve a payment: Hire AirNest, 0.03 USDC, code abc123]",
    ]);
  });
});
