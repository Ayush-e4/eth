import { z } from "zod";

/** INR value of one unit of each currency. Agent fees are USDC, valued at the USD rate. */
export type InrRates = Record<string, number>;

const FX_URL = "https://api.frankfurter.dev/v1/latest?base=INR"; // ECB reference rates, no key

export async function fetchInrRates(fetchImpl: typeof fetch = fetch): Promise<InrRates> {
  const res = await fetchImpl(FX_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FX rates → HTTP ${res.status}`);
  const { rates } = z
    .object({ rates: z.record(z.string(), z.number().positive()) })
    .parse(await res.json());
  const inr: InrRates = { INR: 1 };
  for (const [currency, perInr] of Object.entries(rates)) inr[currency] = 1 / perInr;
  if (inr.USD) inr.USDC = inr.USD;
  return inr;
}

export interface Candidate {
  key: `0x${string}`;
  agent: `0x${string}`;
  title: string;
  note: string;
  feeUnits: bigint; // USDC base units
  itemTotal?: number;
  itemCurrency?: string;
}

export interface Priced extends Candidate {
  itemInr: number;
  feeInr: number;
  totalInr: number;
}

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Procurement: rank quotes by what the traveller really pays — the item (ticket, room) plus the
 * agent's fee — in INR, cheapest first. A cheap agent with an expensive ticket loses.
 * Quotes without a convertible item price can't be compared and are returned separately.
 */
export function rankByTotalCost(candidates: Candidate[], rates: InrRates) {
  const priced: Priced[] = [];
  const unpriced: Candidate[] = [];
  for (const c of candidates) {
    const rate = c.itemCurrency ? rates[c.itemCurrency] : undefined;
    if (c.itemTotal === undefined || rate === undefined) {
      unpriced.push(c);
      continue;
    }
    const itemInr = c.itemTotal * rate;
    const feeInr = (Number(c.feeUnits) / 1e6) * (rates.USDC ?? 0);
    priced.push({ ...c, itemInr, feeInr, totalInr: itemInr + feeInr });
  }
  priced.sort((a, b) => a.totalInr - b.totalInr || Number(a.feeUnits - b.feeUnits));
  unpriced.sort((a, b) => Number(a.feeUnits - b.feeUnits));
  return { priced, unpriced };
}

export function describePriced(p: Priced): string {
  const native = p.itemCurrency === "INR" ? "" : ` (${p.itemTotal} ${p.itemCurrency} at ECB rate)`;
  return `${inr(p.totalInr)} total = item ${inr(p.itemInr)}${native} + agent fee ${inr(p.feeInr)}`;
}
