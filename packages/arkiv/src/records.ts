import { addr, bool, i32, key, str, u64 } from "@arkiv-network/sdk/attr";
import { z } from "zod";
import { PROJECT } from "./config";

/**
 * The marketplace's public records. Attributes are what we filter on (typed, ≤128-byte
 * strings); payloads carry everything else as JSON. Who wrote a record is `$creator`,
 * which Arkiv sets and nobody can forge — readers verify it (see read.ts).
 */

export type Kind = "agent" | "listing" | "quote" | "job" | "receipt" | "rating";

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

export type Agent = z.infer<typeof AgentSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Rating = z.infer<typeof RatingSchema>;

const base = (kind: Kind) => ({ project: str(PROJECT), kind: str(kind) });

/** Typed attributes per record. Only these are indexed; the rest goes in the payload. */
export const attributesFor = {
  agent: (a: Agent) => ({
    ...base("agent"),
    agent: addr(a.agent),
    skill: str(a.skill),
    hedera_account: str(a.hederaAccount),
    ...(a.erc8004Id !== undefined ? { erc8004_id: u64(a.erc8004Id) } : {}),
  }),
  listing: (l: Listing) => ({
    ...base("listing"),
    agent: addr(l.agent),
    skill: str(l.skill),
    price_units: u64(l.priceUnits),
    accepts_credits: bool(l.acceptsCredits),
  }),
  quote: (q: Quote) => ({
    ...base("quote"),
    agent: addr(q.agent),
    task: str(q.task),
    skill: str(q.skill),
    price_units: u64(q.priceUnits),
    ...(q.credits !== undefined ? { credits: u64(q.credits) } : {}),
    ...(q.listing ? { listing: key(q.listing) } : {}),
  }),
  job: (j: Job) => ({
    ...base("job"),
    task: str(j.task),
    buyer: addr(j.buyer),
    seller: addr(j.seller),
    quote: key(j.quote),
    status: str(j.status),
    mandate_id: u64(j.mandateId),
  }),
  receipt: (r: Receipt) => ({
    ...base("receipt"),
    job: key(r.job),
    task: str(r.task),
    mandate_id: u64(r.mandateId),
    payer: str(r.payer),
    pay_to: str(r.payTo),
    amount_units: u64(r.amountUnits),
    hedera_tx: str(r.hederaTx),
    ...(r.hcsSequence !== undefined ? { hcs_seq: u64(r.hcsSequence) } : {}),
  }),
  rating: (r: Rating) => ({
    ...base("rating"),
    agent: addr(r.agent),
    job: key(r.job),
    rater: addr(r.rater),
    score: i32(r.score),
  }),
} as const;

/** JSON payloads can't hold bigint; store them as decimal strings. */
export function toPayloadJson(record: object): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Record<string, unknown>;
}
