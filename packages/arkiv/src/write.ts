import { jsonToPayload } from "@arkiv-network/sdk";
import { str } from "@arkiv-network/sdk/attr";
import { type ArkivWriter, LIFETIME } from "./config";
import {
  type Agent,
  AgentSchema,
  attributesFor,
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
  toPayloadJson,
} from "./records";

const json = "application/json" as const;

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
        payload: jsonToPayload(toPayloadJson(a)),
        contentType: json,
        attributes: attributesFor.agent(a),
        expires: LIFETIME.agent(),
      },
      ...ls.map((l) => ({
        payload: jsonToPayload(toPayloadJson(l)),
        contentType: json,
        attributes: attributesFor.listing(l),
        expires: LIFETIME.listing(),
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
    extensions: entityKeys.map((entityKey) => ({ entityKey, expires: LIFETIME.agent() })),
  });
}

/** Agent bids on a task. The quote disappears from every query after `ttlSeconds`. */
export async function postQuote(w: ArkivWriter, quote: Quote, ttlSeconds = 180) {
  const q = QuoteSchema.parse(quote);
  return w.createEntity({
    payload: jsonToPayload(toPayloadJson(q)),
    contentType: json,
    attributes: attributesFor.quote(q),
    expires: LIFETIME.quote(ttlSeconds),
  });
}

/** Buyer records that it hired a seller for a task. */
export async function openJob(w: ArkivWriter, job: Job) {
  const j = JobSchema.parse(job);
  return w.createEntity({
    payload: jsonToPayload(toPayloadJson(j)),
    contentType: json,
    attributes: attributesFor.job(j),
    expires: LIFETIME.job(),
  });
}

/** Only the buyer (owner) can move a job along; Arkiv rejects anyone else. */
export function setJobStatus(
  w: ArkivWriter,
  jobKey: `0x${string}`,
  status: (typeof JOB_STATUS)[number],
) {
  return w.patchEntity({ entityKey: jobKey, set: { status: str(status) } });
}

/** Platform publishes a read-only receipt pointing at the Hedera settlement. */
export async function recordReceipt(w: ArkivWriter, receipt: Receipt) {
  const r = ReceiptSchema.parse(receipt);
  return w.createEntity({
    payload: jsonToPayload(toPayloadJson(r)),
    contentType: json,
    attributes: attributesFor.receipt(r),
    expires: LIFETIME.receipt(),
    flags: { readonly: true },
  });
}

/** Buyer rates the seller once per job. Read-only so it can't be edited later. */
export async function rateAgent(w: ArkivWriter, rating: Rating) {
  const r = RatingSchema.parse(rating);
  if (r.rater.toLowerCase() !== w.account.address.toLowerCase()) {
    throw new Error("Ratings must be written by the rater");
  }
  return w.createEntity({
    payload: jsonToPayload(toPayloadJson(r)),
    contentType: json,
    attributes: attributesFor.rating(r),
    expires: LIFETIME.rating(),
    flags: { readonly: true },
  });
}
