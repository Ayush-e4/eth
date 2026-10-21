import { addr, str, u64 } from "@arkiv-network/sdk/attr";
import { eq, lte } from "@arkiv-network/sdk/query";
import { type ArkivReader, PROJECT } from "./config";
import { type Decoded, decodeEntity, type RawEntity } from "./decode";
import type { Agent, Job, Kind, Listing, Quote, Rating, Receipt } from "./records";

const FIELDS = {
  key: true,
  creator: true,
  expiresAt: true,
  payload: true,
  attributes: true,
} as const;
const BLOCK_SECONDS = 2n;

type Filter = ReturnType<typeof eq>;

async function query<K extends Kind>(
  r: ArkivReader,
  kind: K,
  filters: Filter[],
  opts: { createdBy?: `0x${string}`; limit?: number } = {},
) {
  let builder = r
    .select(FIELDS)
    .where(eq("project", str(PROJECT)), eq("kind", str(kind)), ...filters)
    .limit(opts.limit ?? 100);
  if (opts.createdBy) builder = builder.createdBy(opts.createdBy);
  const page = await builder.fetch();
  return page.entities
    .map((e) => decodeEntity(kind, e as unknown as RawEntity))
    .filter((d): d is NonNullable<typeof d> => d !== null);
}

export function findAgents(r: ArkivReader, opts: { skill?: string } = {}) {
  const filters = opts.skill ? [eq("skill", str(opts.skill))] : [];
  return query(r, "agent", filters) as Promise<Decoded<Agent>[]>;
}

/** Listings for a skill, optionally under a price (USDC base units), cheapest first. */
export async function findListings(
  r: ArkivReader,
  opts: { skill: string; maxPriceUnits?: bigint },
): Promise<Decoded<Listing>[]> {
  const filters: Filter[] = [eq("skill", str(opts.skill))];
  if (opts.maxPriceUnits !== undefined) filters.push(lte("price_units", u64(opts.maxPriceUnits)));
  const found = (await query(r, "listing", filters)) as Decoded<Listing>[];
  return found.sort((a, b) => (a.record.priceUnits < b.record.priceUnits ? -1 : 1));
}

export interface LiveQuote extends Decoded<Quote> {
  secondsLeft: number;
}

/** Quotes still alive for a task, cheapest first. Expired ones are gone from Arkiv itself. */
export async function liveQuotes(r: ArkivReader, task: string): Promise<LiveQuote[]> {
  const [quotes, head] = await Promise.all([
    query(r, "quote", [eq("task", str(task))]) as Promise<Decoded<Quote>[]>,
    r.getBlockNumber(),
  ]);
  return quotes
    .map((q) => ({ ...q, secondsLeft: Number((q.expiresAt - head) * BLOCK_SECONDS) }))
    .sort((a, b) => (a.record.priceUnits < b.record.priceUnits ? -1 : 1));
}

export function jobsForTask(r: ArkivReader, task: string) {
  return query(r, "job", [eq("task", str(task))]) as Promise<Decoded<Job>[]>;
}

/** Receipts are only trusted if the platform wallet wrote them ($creator can't be forged). */
export function receiptsForTask(r: ArkivReader, task: string, platform: `0x${string}`) {
  return query(r, "receipt", [eq("task", str(task))], { createdBy: platform }) as Promise<
    Decoded<Receipt>[]
  >;
}

/** An agent's ratings (one per job per rater) and their average. */
export async function ratingsFor(r: ArkivReader, agent: `0x${string}`) {
  const all = (await query(r, "rating", [eq("agent", addr(agent))], {
    limit: 200,
  })) as Decoded<Rating>[];
  const seen = new Set<string>();
  const unique = all.filter((x) => {
    const id = `${x.record.job}|${x.record.rater.toLowerCase()}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const average = unique.length
    ? unique.reduce((s, x) => s + x.record.score, 0) / unique.length
    : null;
  return { ratings: unique, average };
}
