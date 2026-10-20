/** USDC on Hedera has 6 decimals: 1 USDC = 1_000_000 base units. */
export const USDC_DECIMALS = 6;

/** "1.5" → 1_500_000n. Rejects more than 6 decimal places instead of silently rounding. */
export function usdcToUnits(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid USDC amount: "${amount}"`);
  const whole = BigInt(match[1] ?? "0");
  const frac = BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * 10n ** BigInt(USDC_DECIMALS) + frac;
}

/** 1_500_000n → "1.5" */
export function unitsToUsdc(units: bigint): string {
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / base;
  const frac = (units % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** 1 HBAR = 100_000_000 tinybars. */
export function tinybarsToHbar(tinybars: bigint): string {
  const base = 100_000_000n;
  const frac = (tinybars % base).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${tinybars / base}.${frac}` : (tinybars / base).toString();
}
