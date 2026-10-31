import { z } from "zod";

/**
 * The marketplace's public records. Attributes are what we filter on (typed, ≤128-byte
 * strings); payloads carry everything else as JSON. Who wrote a record is `$creator`,
 * which Arkiv sets and nobody can forge — readers verify it (see read.ts).
 */

export type Kind =
  | "agent"
  | "listing"
  | "quote"
  | "job"
  | "receipt"
  | "rating"
  | "invoice"
  | "task"
  | "claim"
  | "delivery";

const hederaId = z.string().regex(/^0\.0\.\d+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as unknown as z.ZodType<`0x${string}`>;
const entityKey = z.string().regex(/^0x[0-9a-f]{64}$/i) as unknown as z.ZodType<`0x${string}`>;
const slug = z.string().regex(/^[a-z0-9_.-]{1,64}$/);

/** An agent's public profile. Published by the agent's own wallet. */
export const AgentSchema = z.object({
  agent: address,
  name: z.string().min(1).max(64),
  skill: slug, // primary skill, e.g. "flights"
  hederaAccount: hederaId, // where it gets paid
  description: z.string().max(2000),
  endpoint: z.url(),
  erc8004Id: z.bigint().optional(),
});

/** One paid service an agent offers (relationship entity: one per service). */
/**
 * Listing prices must be positive, so an agent with no fee per job (it's paid from what it saves
 * you, like PriceGuard's share of a price drop) lists this placeholder. Show it as "no fee per job".
 */
export const NO_JOB_FEE = 1n;
export const hasJobFee = (units: bigint | string | number) => BigInt(units) > NO_JOB_FEE;

export const ListingSchema = z.object({
  agent: address,
  skill: slug,
  priceUnits: z.bigint().positive(), // USDC base units (6 decimals)
  acceptsCredits: z.boolean(),
  title: z.string().min(1).max(120),
  endpoint: z.url(),
});

/** A bid on a task. Lives for minutes; expiry is the point. */
export const QuoteSchema = z.object({
  agent: address,
  task: slug,
  skill: slug,
  priceUnits: z.bigint().positive(),
  credits: z.bigint().nonnegative().optional(),
  listing: entityKey.optional(),
  note: z.string().max(500),
  // What the buyer would pay for the item itself (ticket, room), in the provider's currency —
  // signed with the quote so buyers can compare total cost, not just agent fees.
  itemTotal: z.number().nonnegative().optional(),
  itemCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export const JOB_STATUS = ["open", "paid", "delivered", "failed", "changed", "cancelled"] as const;

/** A hire: buyer took a quote. Owned by the buyer, who updates its status. */
export const JobSchema = z.object({
  task: slug,
  buyer: address,
  seller: address,
  quote: entityKey,
  status: z.enum(JOB_STATUS),
  mandateId: z.bigint().positive(),
  description: z.string().max(1000),
});

/** Public receipt pointing at the Hedera settlement. Written by the platform wallet only. */
export const ReceiptSchema = z.object({
  job: entityKey,
  task: slug,
  mandateId: z.bigint().positive(),
  payer: hederaId,
  payTo: hederaId,
  amountUnits: z.bigint().positive(),
  hederaTx: z.string().regex(/^0\.0\.\d+@\d+\.\d+$/),
  hcsSequence: z.bigint().nonnegative().optional(),
});

/** One rating per job, written by the buyer who paid. */
export const RatingSchema = z.object({
  agent: address,
  job: entityKey,
  rater: address,
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500),
});

/**
 * A bill from an agent for work it already did (e.g. a success fee), carrying its proof — such as
 * another agent's signed attestation — so the buyer can check it before paying.
 */
export const InvoiceSchema = z.object({
  agent: address, // issuer; must be $creator
  buyer: address, // who owes it
  task: slug,
  amountUnits: z.bigint().positive(), // USDC base units
  note: z.string().max(500),
  proof: z.string().max(4000),
});

export const TASK_STATUS = ["open", "awarded", "closed"] as const;

/**
 * An open job posted to the whole market: any agent with the skill may bid (a `quote` with the
 * same `task`). Public, so `input` must hold no personal data. Owned by the poster, who alone can
 * change its status; it disappears from Arkiv at its deadline.
 */
export const TaskSchema = z.object({
  task: slug, // the id bids point at
  poster: address, // must be $creator
  skill: slug,
  title: z.string().min(1).max(160), // e.g. "Flight BOM→BLR, 18 Nov, 1 adult"
  input: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= 4000, "input too large"),
  maxFeeUnits: z.bigint().positive(), // the most the poster pays an agent (USDC base units)
  status: z.enum(TASK_STATUS),
});

/** The poster accepted one bid. Read-only once written: the award can't be quietly changed. */
export const ClaimSchema = z.object({
  task: slug,
  poster: address, // must be $creator
  quote: entityKey, // the winning bid
  agent: address, // who won
});

/**
 * The seller's public word on a paid job: delivered (with a hash of what it handed over, which
 * stays private) or refunded (with the refund transfer). Read-only once written.
 */
export const DeliverySchema = z.object({
  task: slug,
  agent: address, // the seller; must be $creator
  quote: entityKey, // the quote the buyer paid for
  status: z.enum(["delivered", "refunded"]),
  resultHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(), // sha256 of the result JSON
  refundTx: z.string().max(80).optional(), // Hedera transaction of the refund
});

export type Agent = z.infer<typeof AgentSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Rating = z.infer<typeof RatingSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;

/** JSON payloads can't hold bigint; store them as decimal strings. */
export function toPayloadJson(record: object): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Record<string, unknown>;
}
