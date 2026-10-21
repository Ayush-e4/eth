import type { Trip } from "../trip";
import { type Explanation, explainRun } from "./explain";
import { type Hire, type HireDeps, hire } from "./hire";
import { planTrip } from "./plan";

export interface TripRun {
  task: string;
  trip: Trip;
  hires: Hire[];
  failures: string[];
  explanation: Explanation;
}

/**
 * The orchestrator: understand the request, hire a flights agent and a hotels agent in
 * parallel (each paid through the mandate), then explain every spend.
 */
export async function runTrip(request: string, deps: HireDeps): Promise<TripRun> {
  const trip = await planTrip(request);
  const task = `trip-${trip.destination.toLowerCase()}-${Date.now().toString(36)}`;
  deps.log(
    `plan: ${trip.adults} adult(s) ${trip.origin}→${trip.destination} ${trip.departDate}…${trip.returnDate} (task ${task})`,
  );

  const settled = await Promise.allSettled(
    ["flights", "hotels"].map((skill) => hire(skill, task, trip, deps)),
  );
  const hires = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failures = settled.flatMap((s) =>
    s.status === "rejected"
      ? [String(s.reason instanceof Error ? s.reason.message : s.reason)]
      : [],
  );
  for (const f of failures) deps.log(`failed: ${f}`);

  const explanation = await explainRun(trip, hires, failures);
  return { task, trip, hires, failures, explanation };
}
