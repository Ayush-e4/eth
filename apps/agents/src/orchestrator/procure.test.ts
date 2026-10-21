import { describe, expect, it } from "vitest";
import { type Candidate, describePriced, fetchInrRates, rankByTotalCost } from "./procure";

const rates = { INR: 1, GBP: 126.61, USD: 94.47, USDC: 94.47 };
const cand = (key: string, feeUnits: bigint, itemTotal?: number, itemCurrency?: string) =>
  ({ key, agent: key, title: key, note: "", feeUnits, itemTotal, itemCurrency }) as Candidate;

describe("procurement", () => {
  it("ranks by item + fee in INR, not by agent fee alone", () => {
    const { priced } = rankByTotalCost(
      [cand("0xcheapfee", 10_000n, 50, "GBP"), cand("0xcheapticket", 90_000n, 5000, "INR")],
      rates,
    );
    expect(priced.map((p) => p.key)).toEqual(["0xcheapticket", "0xcheapfee"]);
    expect(priced[0]?.totalInr).toBeCloseTo(5000 + 0.09 * 94.47, 2);
    expect(priced[1]?.itemInr).toBeCloseTo(50 * 126.61, 2);
  });

  it("keeps quotes it can't compare apart (no price, or unknown currency)", () => {
    const { priced, unpriced } = rankByTotalCost(
      [cand("0xa", 1n), cand("0xb", 2n, 10, "XYZ"), cand("0xc", 3n, 10, "INR")],
      rates,
    );
    expect(priced.map((p) => p.key)).toEqual(["0xc"]);
    expect(unpriced.map((p) => p.key)).toEqual(["0xa", "0xb"]);
  });

  it("explains a price in plain words", () => {
    const [p] = rankByTotalCost([cand("0xa", 50_000n, 41.2, "GBP")], rates).priced;
    expect(p && describePriced(p)).toBe(
      "₹5,221 total = item ₹5,216 (41.2 GBP at ECB rate) + agent fee ₹5",
    );
  });

  it("turns ECB rates (per 1 INR) into INR per unit, valuing USDC at the USD rate", async () => {
    const fx = (async () =>
      Response.json({ base: "INR", rates: { GBP: 0.0079, USD: 0.010585 } })) as never;
    const r = await fetchInrRates(fx);
    expect(r.INR).toBe(1);
    expect(r.GBP).toBeCloseTo(126.58, 1);
    expect(r.USDC).toBe(r.USD);
  });
});
