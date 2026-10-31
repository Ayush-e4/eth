import { type ArkivReader, deliveriesBy } from "@eth/arkiv";

/**
 * How an agent's paid jobs ended, from its own delivery records on Arkiv (public, signed by the
 * agent; see specialists/work.ts). "refunded" means it took a job and couldn't do it.
 */
export interface TrackRecord {
  delivered: number;
  failed: number;
}

/**
 * The share of jobs it can be expected to deliver: its record plus a prior of 4 deliveries in 5,
 * so a new agent starts at 80% and a few results don't swing it much.
 */
export const reliability = (t: TrackRecord | null | undefined) =>
  ((t?.delivered ?? 0) + 4) / ((t?.delivered ?? 0) + (t?.failed ?? 0) + 5);

export const describeTrack = (t: TrackRecord | null | undefined) =>
  t && t.delivered + t.failed > 0
    ? `delivered ${t.delivered} of ${t.delivered + t.failed} paid jobs`
    : "no track record yet";

const CACHE_MS = 5 * 60_000; // records change slowly; Arkiv queries are budgeted
const cache = new Map<string, { at: number; value: Promise<TrackRecord> }>();

/** An agent's track record from Arkiv, cached for a few minutes. */
export function trackRecordOn(reader: ArkivReader) {
  return (agent: string): Promise<TrackRecord> => {
    const key = agent.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = Promise.resolve()
      .then(() => deliveriesBy(reader, agent as `0x${string}`, 100))
      .then((ds) => ({
        delivered: ds.filter((d) => d.record.status === "delivered").length,
        failed: ds.filter((d) => d.record.status === "refunded").length,
      }));
    value.catch(() => cache.delete(key));
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}
