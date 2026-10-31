import { bytes, str } from "@arkiv-network/sdk/schema";
import { stringToBytes } from "viem";
import { type ArkivWriter, LIFETIME } from "./config";
import {
  type Agent,
  AgentSchema,
  type Claim,
  ClaimSchema,
  type Invoice,
  InvoiceSchema,
  type JOB_STATUS,
  type Job,
  JobSchema,
  type Listing,
  ListingSchema,
  type Quote,
  QuoteSchema,
  type Rating,
  RatingSchema,
  type Receipt,
  ReceiptSchema,
  type TASK_STATUS,
  type Task,
  TaskSchema,
  toPayloadJson,
} from "./records";
import { ARKIV_SCHEMAS, attributesFor } from "./schemas";

/** The whole record as JSON bytes, for the schema's `body` column. */
const bodyOf = (record: object) => bytes(stringToBytes(JSON.stringify(toPayloadJson(record))));
// Each schema types its own values; ours are built per kind by attributesFor, so we widen here.
type AnyValues = never;

/** Agent publishes its profile and all its listings in one atomic transaction. */
export async function publishAgent(w: ArkivWriter, agent: Agent, listings: Listing[]) {
  const a = AgentSchema.parse(agent);
  const ls = listings.map((l) => ListingSchema.parse(l));
  const self = w.account.address.toLowerCase();
  if ([a.agent, ...ls.map((l) => l.agent)].some((x) => x.toLowerCase() !== self)) {
    throw new Error("An agent can only publish records about itself");
  }
  const result = await w.executeBatch({
    creates: [
      {
        schema: ARKIV_SCHEMAS.agent,
        values: { ...attributesFor.agent(a), body: bodyOf(a) } as AnyValues,
        expiration: LIFETIME.agent(),
      },
      ...ls.map((l) => ({
        schema: ARKIV_SCHEMAS.listing,
        values: { ...attributesFor.listing(l), body: bodyOf(l) } as AnyValues,
        expiration: LIFETIME.listing(),
      })),
    ],
  });
  const [profile, ...listingKeys] = result.createdEntities;
  return { profile, listings: listingKeys, txHash: result.txHash };
}

/**
 * Keeps an agent's profile and listings alive another 30 days. Arkiv's extension SETS a new
 * expiry counted from now (it does not add to the old one) and never shortens a life.
 */
export async function renewAgent(w: ArkivWriter, entityKeys: `0x${string}`[]) {
  return w.executeBatch({
    extensions: entityKeys.map((entityKey) => ({ entityKey, expiration: LIFETIME.agent() })),
  });
}

/** Agent bids on a task. The quote disappears from every query after `ttlSeconds`. */
export async function postQuote(w: ArkivWriter, quote: Quote, ttlSeconds = 180) {
  const q = QuoteSchema.parse(quote);
  return w.createEntity(
    ARKIV_SCHEMAS.quote,
    { ...attributesFor.quote(q), body: bodyOf(q) } as AnyValues,
    { expiration: LIFETIME.quote(ttlSeconds) },
  );
}

/** Buyer records that it hired a seller for a task. */
export async function openJob(w: ArkivWriter, job: Job) {
  const j = JobSchema.parse(job);
  return w.createEntity(
    ARKIV_SCHEMAS.job,
    { ...attributesFor.job(j), body: bodyOf(j) } as AnyValues,
    { expiration: LIFETIME.job() },
  );
}

/** Only the buyer (owner) can move a job along; Arkiv rejects anyone else. */
export function setJobStatus(
  w: ArkivWriter,
  jobKey: `0x${string}`,
  status: (typeof JOB_STATUS)[number],
) {
  return w.patchEntity(ARKIV_SCHEMAS.job, jobKey, { set: { status: str(status) } });
}

/** Platform publishes a read-only receipt pointing at the Hedera settlement. */
export async function recordReceipt(w: ArkivWriter, receipt: Receipt) {
  const r = ReceiptSchema.parse(receipt);
  return w.createEntity(
    ARKIV_SCHEMAS.receipt,
    { ...attributesFor.receipt(r), body: bodyOf(r) } as AnyValues,
    { expiration: LIFETIME.receipt(), flags: { readonly: true } },
  );
}

/** Buyer rates the seller once per job. Read-only so it can't be edited later. */
export async function rateAgent(w: ArkivWriter, rating: Rating) {
  const r = RatingSchema.parse(rating);
  if (r.rater.toLowerCase() !== w.account.address.toLowerCase()) {
    throw new Error("Ratings must be written by the rater");
  }
  return w.createEntity(
    ARKIV_SCHEMAS.rating,
    { ...attributesFor.rating(r), body: bodyOf(r) } as AnyValues,
    { expiration: LIFETIME.rating(), flags: { readonly: true } },
  );
}

/** An agent bills a buyer for work already done, with the proof the buyer will check. */
export async function issueInvoice(w: ArkivWriter, invoice: Invoice) {
  const i = InvoiceSchema.parse(invoice);
  return w.createEntity(
    ARKIV_SCHEMAS.invoice,
    { ...attributesFor.invoice(i), body: bodyOf(i) } as AnyValues,
    { expiration: LIFETIME.invoice() },
  );
}

/** Poster opens a job to the whole market. It vanishes from every query at its deadline. */
export async function postTask(w: ArkivWriter, task: Task, ttlSeconds = 600) {
  const t = TaskSchema.parse(task);
  if (t.poster.toLowerCase() !== w.account.address.toLowerCase())
    throw new Error("Tasks must be written by their poster");
  return w.createEntity(
    ARKIV_SCHEMAS.task,
    { ...attributesFor.task(t), body: bodyOf(t) } as AnyValues,
    { expiration: LIFETIME.task(ttlSeconds) },
  );
}

/** Only the poster (owner) can award or close a task; Arkiv rejects anyone else. */
export function setTaskStatus(
  w: ArkivWriter,
  taskKey: `0x${string}`,
  status: (typeof TASK_STATUS)[number],
) {
  return w.patchEntity(ARKIV_SCHEMAS.task, taskKey, { set: { status: str(status) } });
}

/** Poster records which bid won. Read-only, and kept a week as the public record. */
export async function claimTask(w: ArkivWriter, claim: Claim) {
  const c = ClaimSchema.parse(claim);
  if (c.poster.toLowerCase() !== w.account.address.toLowerCase())
    throw new Error("Claims must be written by the task's poster");
  return w.createEntity(
    ARKIV_SCHEMAS.claim,
    { ...attributesFor.claim(c), body: bodyOf(c) } as AnyValues,
    { expiration: LIFETIME.claim(), flags: { readonly: true } },
  );
}
