import { and, eq, lte } from "@arkiv-network/sdk/query";
import { addr, key, str, u64 } from "@arkiv-network/sdk/schema";
import { hexToBytes, isHex } from "viem";
import type { ArkivReader } from "./config";
import { type Decoded, decodeEntity, type RawEntity } from "./decode";
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
import { ARKIV_SCHEMAS } from "./schemas";

const BLOCK_SECONDS = 2n;

type Filter = ReturnType<typeof eq>;

/** A query row (SDK 1.0) as the raw entity our decoder checks: system fields, columns, body. */
function toRaw(row: Record<string, unknown>): RawEntity {
  const attributes: RawEntity["attributes"] = {};
  for (const [name, v] of Object.entries(row))
    if (!name.startsWith("$") && name !== "body" && v && typeof v === "object")
      attributes[name] = v as { type: string; value: unknown };
  const b = (row.body as { value?: unknown } | undefined)?.value;
  return {
    key: row.$key as `0x${string}`,
    creator: row.$creator as `0x${string}`,
    expiresAt: BigInt(row.$expiresAt as bigint),
    payload: b instanceof Uint8Array ? b : isHex(b) ? hexToBytes(b) : new Uint8Array(),
    attributes,
  };
}

async function query<K extends Kind>(
  r: ArkivReader,
  kind: K,
  filters: Filter[],
  opts: { createdBy?: `0x${string}`; limit?: number } = {},
) {
  // A named schema only matches its own kind of our records; `where` narrows further.
  let builder = r.select().from(ARKIV_SCHEMAS[kind] as never) as unknown as {
    where(e: unknown): typeof builder;
    limit(n: number): typeof builder;
    createdBy(a: `0x${string}`): typeof builder;
    fetch(): Promise<{ entities: Record<string, unknown>[] }>;
  };
  if (filters.length) builder = builder.where(filters.length === 1 ? filters[0] : and(...filters));
  builder = builder.limit(opts.limit ?? 100);
  if (opts.createdBy) builder = builder.createdBy(opts.createdBy);
  const page = await builder.fetch();
  return page.entities
    .map((e) => decodeEntity(kind, toRaw(e)))
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

/** Invoices addressed to a buyer (each one written by the agent that issued it). */
export function invoicesFor(r: ArkivReader, buyer: `0x${string}`) {
  return query(r, "invoice", [eq("buyer", addr(buyer))]) as Promise<Decoded<Invoice>[]>;
}

/** Tasks still taking bids (expired ones are gone from Arkiv), optionally for one skill. */
export function openTasks(r: ArkivReader, opts: { skill?: string } = {}) {
  const filters = [
    eq("status", str("open")),
    ...(opts.skill ? [eq("skill", str(opts.skill))] : []),
  ];
  return query(r, "task", filters) as Promise<Decoded<Task>[]>;
}

/** Every live task (open or awarded), newest first as Arkiv returns them. */
export function liveTasks(r: ArkivReader) {
  return query(r, "task", []) as Promise<Decoded<Task>[]>;
}

/** How the agent says a paid job ended, trusted only if that agent wrote it. */
export async function deliveryFor(r: ArkivReader, quote: `0x${string}`, agent: `0x${string}`) {
  const [d] = (await query(r, "delivery", [eq("quote", key(quote))], {
    createdBy: agent,
  })) as Decoded<Delivery>[];
  return d ?? null;
}

/** The award for a task, trusted only if the task's poster wrote it. */
export async function claimFor(r: ArkivReader, task: string, poster: `0x${string}`) {
  const [c] = (await query(r, "claim", [eq("task", str(task))], {
    createdBy: poster,
  })) as Decoded<Claim>[];
  return c ?? null;
}
