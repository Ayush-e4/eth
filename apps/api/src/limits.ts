import { z } from "zod";

/** A chat (or default) agent-fee limit can't exceed 5 USDC, the monthly default. */
export const MAX_LIMIT_UNITS = 5_000_000n;

/** Agent-fee limit in USDC base units, as a string (bigints don't survive JSON). */
export const limitUnitsSchema = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(BigInt)
  .refine((u) => u <= MAX_LIMIT_UNITS, "at most 5 USDC");
