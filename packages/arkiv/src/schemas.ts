import { addr, bool, bytes, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import { PROJECT } from "./config";
import type {
  Agent,
  Claim,
  Delivery,
  Invoice,
  Job,
  Kind,
  Listing,
  Quote,
  Rating,
  Receipt,
  Task,
} from "./records";

/**
 * One named Arkiv schema per kind. The name (`eth-agentnet-mumbai26.quote`, …) tags every entity,
 * so our queries never match other apps' data. Indexed columns are what we filter on; `body`
 * holds the whole record as JSON (decoded and validated by decodeEntity).
 */
const named = (kind: Kind) => `${PROJECT}.${kind}`;
const body = bytes();

export const ARKIV_SCHEMAS = {
  agent: defineSchema(named("agent"), {
    agent: addr().indexed(),
    skill: str().indexed(),
    hedera_account: str().indexed(),
    erc8004_id: u64().indexed().optional(),
    body,
  }),
  listing: defineSchema(named("listing"), {
    agent: addr().indexed(),
    skill: str().indexed(),
    price_units: u64().indexed(),
    accepts_credits: bool().indexed(),
    body,
  }),
  quote: defineSchema(named("quote"), {
    agent: addr().indexed(),
    task: str().indexed(),
    skill: str().indexed(),
    price_units: u64().indexed(),
    credits: u64().indexed().optional(),
    listing: key().indexed().optional(),
    body,
  }),
  job: defineSchema(named("job"), {
    task: str().indexed(),
    buyer: addr().indexed(),
    seller: addr().indexed(),
    quote: key().indexed(),
    status: str().indexed(),
    mandate_id: u64().indexed(),
    body,
  }),
  receipt: defineSchema(named("receipt"), {
    job: key().indexed(),
    task: str().indexed(),
    mandate_id: u64().indexed(),
    payer: str().indexed(),
    pay_to: str().indexed(),
    amount_units: u64().indexed(),
    hedera_tx: str().indexed(),
    hcs_seq: u64().indexed().optional(),
    body,
  }),
  rating: defineSchema(named("rating"), {
    agent: addr().indexed(),
    job: key().indexed(),
    rater: addr().indexed(),
    score: i32().indexed(),
    body,
  }),
  invoice: defineSchema(named("invoice"), {
    agent: addr().indexed(),
    buyer: addr().indexed(),
    task: str().indexed(),
    amount_units: u64().indexed(),
    body,
  }),
  task: defineSchema(named("task"), {
    task: str().indexed(),
    poster: addr().indexed(),
    skill: str().indexed(),
    max_fee_units: u64().indexed(),
    status: str().indexed(),
    body,
  }),
  claim: defineSchema(named("claim"), {
    task: str().indexed(),
    poster: addr().indexed(),
    quote: key().indexed(),
    agent: addr().indexed(),
    body,
  }),
  delivery: defineSchema(named("delivery"), {
    task: str().indexed(),
    agent: addr().indexed(),
    quote: key().indexed(),
    status: str().indexed(),
    body,
  }),
} as const;

/** Typed values for each kind's indexed columns (the `body` column is added by the writer). */
export const attributesFor = {
  agent: (a: Agent) => ({
    agent: addr(a.agent),
    skill: str(a.skill),
    hedera_account: str(a.hederaAccount),
    ...(a.erc8004Id !== undefined ? { erc8004_id: u64(a.erc8004Id) } : {}),
  }),
  listing: (l: Listing) => ({
    agent: addr(l.agent),
    skill: str(l.skill),
    price_units: u64(l.priceUnits),
    accepts_credits: bool(l.acceptsCredits),
  }),
  quote: (q: Quote) => ({
    agent: addr(q.agent),
    task: str(q.task),
    skill: str(q.skill),
    price_units: u64(q.priceUnits),
    ...(q.credits !== undefined ? { credits: u64(q.credits) } : {}),
    ...(q.listing ? { listing: key(q.listing) } : {}),
  }),
  job: (j: Job) => ({
    task: str(j.task),
    buyer: addr(j.buyer),
    seller: addr(j.seller),
    quote: key(j.quote),
    status: str(j.status),
    mandate_id: u64(j.mandateId),
  }),
  receipt: (r: Receipt) => ({
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
    agent: addr(r.agent),
    job: key(r.job),
    rater: addr(r.rater),
    score: i32(r.score),
  }),
  invoice: (i: Invoice) => ({
    agent: addr(i.agent),
    buyer: addr(i.buyer),
    task: str(i.task),
    amount_units: u64(i.amountUnits),
  }),
  task: (t: Task) => ({
    task: str(t.task),
    poster: addr(t.poster),
    skill: str(t.skill),
    max_fee_units: u64(t.maxFeeUnits),
    status: str(t.status),
  }),
  claim: (c: Claim) => ({
    task: str(c.task),
    poster: addr(c.poster),
    quote: key(c.quote),
    agent: addr(c.agent),
  }),
  delivery: (d: Delivery) => ({
    task: str(d.task),
    agent: addr(d.agent),
    quote: key(d.quote),
    status: str(d.status),
  }),
} as const;
