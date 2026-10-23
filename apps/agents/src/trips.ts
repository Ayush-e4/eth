import { fileURLToPath } from "node:url";
import type { Explanation } from "./orchestrator/explain";
import type { TripRun } from "./orchestrator/run";
import { JsonStore } from "./store";
import type { Trip } from "./trip";

/** What the orchestrator remembers about a trip, so the traveller can come back and change it. */
export interface TripRecord {
  task: string;
  trip: Trip;
  savedAt: string;
  hires: {
    skill: string;
    agent: `0x${string}`;
    agentTitle: string;
    endpoint: string;
    jobKey: `0x${string}`;
    quoteNote: string;
    bookingId?: string; // hotels: the booking the agent manages
    status: "booked" | "changed" | "cancelled";
    result: unknown;
  }[];
  history: string[]; // what happened after booking, newest last
  explanation?: Explanation;
  priceWatch?: {
    agent: `0x${string}`;
    endpoint: string;
    minSavingInr: number;
    minSavingPercent: number;
  };
  paidInvoices?: string[];
}

export const TRIPS_PATH = fileURLToPath(new URL("../.trips.local.json", import.meta.url));

export const tripStore = (path: string | undefined = TRIPS_PATH) => new JsonStore<TripRecord>(path);

export function toRecord(run: TripRun): TripRecord {
  return {
    task: run.task,
    trip: run.trip,
    savedAt: new Date().toISOString(),
    hires: run.hires.map((h) => ({
      skill: h.skill,
      agent: h.agent,
      agentTitle: h.agentTitle,
      endpoint: h.endpoint,
      jobKey: h.jobKey,
      quoteNote: h.quoteNote,
      bookingId: (h.result as { bookingId?: string } | undefined)?.bookingId,
      status: "booked",
      result: h.result,
    })),
    history: [],
    explanation: run.explanation,
  };
}

export function latestTrip(store: JsonStore<TripRecord>): TripRecord | undefined {
  return store.values().sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
}
