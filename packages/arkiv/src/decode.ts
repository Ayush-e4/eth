import type { z } from "zod";
import {
  AgentSchema,
  InvoiceSchema,
  JobSchema,
  type Kind,
  ListingSchema,
  QuoteSchema,
  RatingSchema,
  ReceiptSchema,
} from "./records";

/** The slice of an Arkiv entity we read (matches select({ key, creator, expiresAt, payload, attributes })). */
export interface RawEntity {
  key: `0x${string}`;
  creator: `0x${string}`;
  expiresAt: bigint;
  payload: Uint8Array;
  attributes: Record<string, { type: string; value: unknown }>;
}

export interface Decoded<T> {
  key: `0x${string}`;
  creator: `0x${string}`;
  expiresAt: bigint;
  record: T;
}

const SCHEMAS = {
  agent: AgentSchema,
  listing: ListingSchema,
  quote: QuoteSchema,
  job: JobSchema,
  receipt: ReceiptSchema,
  rating: RatingSchema,
  invoice: InvoiceSchema,
} as const;

/** Indexed attribute name → record field. Attributes win over the payload: they are what queries matched. */
const ATTR_FIELDS: Record<Kind, Record<string, string>> = {
  agent: {
    agent: "agent",
    skill: "skill",
    hedera_account: "hederaAccount",
    erc8004_id: "erc8004Id",
  },
  listing: {
    agent: "agent",
    skill: "skill",
    price_units: "priceUnits",
    accepts_credits: "acceptsCredits",
  },
  quote: {
    agent: "agent",
    task: "task",
    skill: "skill",
    price_units: "priceUnits",
    credits: "credits",
    listing: "listing",
  },
  job: {
    task: "task",
    buyer: "buyer",
    seller: "seller",
    quote: "quote",
    status: "status",
    mandate_id: "mandateId",
  },
  receipt: {
    job: "job",
    task: "task",
    mandate_id: "mandateId",
    payer: "payer",
    pay_to: "payTo",
    amount_units: "amountUnits",
    hedera_tx: "hederaTx",
    hcs_seq: "hcsSequence",
  },
  rating: { agent: "agent", job: "job", rater: "rater", score: "score" },
  invoice: { agent: "agent", buyer: "buyer", task: "task", amount_units: "amountUnits" },
};

/** Fields stored as bigint in records (decimal strings in JSON payloads). */
const BIGINT_FIELDS = new Set([
  "priceUnits",
  "credits",
  "mandateId",
  "amountUnits",
  "hcsSequence",
  "erc8004Id",
]);

function sameAddress(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Turns an entity into a validated record, or null if it is malformed or fails its trust rule:
 * agent/listing/quote must be written by the agent they describe, a rating by its rater, and a
 * job by its buyer. (Receipts are trusted by filtering on the platform wallet at query time.)
 */
export function decodeEntity<K extends Kind>(
  kind: K,
  e: RawEntity,
): Decoded<z.infer<(typeof SCHEMAS)[K]>> | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(e.payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const [attr, field] of Object.entries(ATTR_FIELDS[kind])) {
    const a = e.attributes[attr];
    if (a) json[field] = a.value;
  }
  for (const field of BIGINT_FIELDS) {
    const v = json[field];
    if (typeof v === "string" || typeof v === "number") json[field] = BigInt(v);
  }

  const parsed = SCHEMAS[kind].safeParse(json);
  if (!parsed.success) return null;
  const record = parsed.data as Record<string, unknown>;

  const author = kind === "rating" ? record.rater : kind === "job" ? record.buyer : record.agent;
  if (kind !== "receipt" && !sameAddress(author, e.creator)) return null;

  return {
    key: e.key,
    creator: e.creator,
    expiresAt: e.expiresAt,
    record: parsed.data as z.infer<(typeof SCHEMAS)[K]>,
  };
}
