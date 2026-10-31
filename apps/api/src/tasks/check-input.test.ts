import { describe, expect, it } from "vitest";
import { inputProblems } from "./check-input";

const schema = {
  type: "object",
  required: ["origin", "departDate", "returnDate", "adults"],
  properties: {
    origin: { type: "string", pattern: "^[A-Z]{3}$" },
    departDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    returnDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    adults: { type: "integer", minimum: 1, maximum: 6 },
  },
};

describe("checking a task's public input against the agents' schema", () => {
  it("passes a complete input", () => {
    expect(
      inputProblems(schema, {
        origin: "BOM",
        departDate: "2026-11-26",
        returnDate: "2026-11-26",
        adults: 1,
      }),
    ).toEqual([]);
  });

  it("names the slips that would leave a task without bids", () => {
    expect(
      inputProblems(schema, {
        origin: "Mumbai",
        departDate: "2026-11-26",
        returnDate: "",
        adults: 9,
      }),
    ).toEqual([
      'origin "Mumbai" doesn\'t match ^[A-Z]{3}$',
      'returnDate "" doesn\'t match ^\\d{4}-\\d{2}-\\d{2}$',
      "adults is above 6",
    ]);
    expect(inputProblems(schema, { origin: "BOM" })).toContain("departDate is missing");
  });
});
