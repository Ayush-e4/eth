import { type Trip, TripSchema } from "../trip";
import { askStructured } from "./claude";

const SYSTEM = `You turn a traveller's request into a structured trip for booking agents.
- origin and destination are 3-letter IATA airport codes (Mumbai = BOM, Goa = GOI, Delhi = DEL, Bengaluru = BLR).
- destinationName is the place the traveller named (e.g. "Goa").
- Dates are YYYY-MM-DD. Look weekdays up in the calendar you are given; never compute them.
  "this Friday" / "next Friday" = the first Friday in the calendar after today.
  Departure is always after today. If no return date is given, return two days after departure.
  If no departure date is given, use the first Friday after today.
- returnFlight is true unless the traveller only wants a one-way flight (e.g. "one way", or returning by train or car).
- adults defaults to 1. budgetInr is the total budget in Indian rupees if stated, else null.
- hotelWishes: what the traveller wants from the hotel in a few words (e.g. "quiet, beachfront"), or "".
- notes: anything else that matters for choosing (e.g. "nonstop flights"), or "".`;

const DAY_MS = 86_400_000;
const IST = "Asia/Kolkata";

/** YYYY-MM-DD in India time (where the traveller is). */
export const istDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: IST });

/** "Thu 2026-10-22 (today), Fri 2026-10-23, …" — Claude looks dates up instead of doing arithmetic. */
export function calendar(today: Date, days = 21): string {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() + i * DAY_MS);
    const weekday = d.toLocaleDateString("en-IN", { weekday: "short", timeZone: IST });
    return `${weekday} ${istDate(d)}${i === 0 ? " (today)" : ""}`;
  }).join(", ");
}

/** Problems with the dates Claude chose, or null if they are bookable. */
export function checkTripDates(trip: Trip, today: Date): string | null {
  const now = istDate(today);
  if (trip.departDate <= now) return `departDate ${trip.departDate} is not after today (${now})`;
  if (trip.returnDate <= trip.departDate) {
    return `returnDate ${trip.returnDate} must be after departDate ${trip.departDate}`;
  }
  return null;
}

/** Claude extracts a bookable trip from free text; dates are checked in code, with one retry. */
export async function planTrip(request: string, today = new Date()): Promise<Trip> {
  const user = `Calendar: ${calendar(today)}\n\nRequest: ${request}`;
  const ask = (extra = "") =>
    askStructured({ schema: TripSchema, system: SYSTEM, user: user + extra, effort: "low" });
  const first = await ask();
  const problem = checkTripDates(first, today);
  if (!problem) return first;
  const second = await ask(`\n\nYour previous answer was wrong: ${problem}. Fix the dates.`);
  const still = checkTripDates(second, today);
  if (still) throw new Error(`Could not plan valid dates: ${still}`);
  return second;
}
