import { type Trip, TripSchema } from "../trip";
import { askStructured } from "./claude";

const SYSTEM = `You turn a traveller's request into a structured trip for booking agents.
- origin and destination are 3-letter IATA airport codes (Mumbai = BOM, Goa = GOI, Delhi = DEL, Bengaluru = BLR).
- destinationName is the place the traveller named (e.g. "Goa").
- Dates are YYYY-MM-DD. Resolve relative dates ("this weekend", "next Friday") from today's date given below.
  If no return date is given, return two days after departure. If no departure date is given, use the coming Friday.
- adults defaults to 1. budgetInr is the total budget in Indian rupees if stated, else null.
- notes: anything else that matters for choosing (preferences, constraints), or "".`;

/** Claude extracts a bookable trip from free text. */
export function planTrip(request: string, today = new Date()): Promise<Trip> {
  return askStructured({
    schema: TripSchema,
    system: SYSTEM,
    user: `Today is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString("en-IN", { weekday: "long" })}).\n\nRequest: ${request}`,
    effort: "low",
  });
}
