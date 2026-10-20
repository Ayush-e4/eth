import { describe, expect, it } from "vitest";
import { tinybarsToHbar, unitsToUsdc, usdcToUnits } from "./units";

describe("USDC units", () => {
  it("converts decimal strings to base units", () => {
    expect(usdcToUnits("1")).toBe(1_000_000n);
    expect(usdcToUnits("1.5")).toBe(1_500_000n);
    expect(usdcToUnits("0.000001")).toBe(1n);
  });

  it("rejects invalid or over-precise amounts", () => {
    expect(() => usdcToUnits("1.0000001")).toThrow();
    expect(() => usdcToUnits("-1")).toThrow();
    expect(() => usdcToUnits("abc")).toThrow();
  });

  it("round-trips", () => {
    for (const a of ["0", "1", "1.5", "123.456789"]) expect(unitsToUsdc(usdcToUnits(a))).toBe(a);
  });
});

describe("tinybarsToHbar", () => {
  it("formats tinybars", () => {
    expect(tinybarsToHbar(100_000_000n)).toBe("1");
    expect(tinybarsToHbar(150_000_000n)).toBe("1.5");
  });
});
