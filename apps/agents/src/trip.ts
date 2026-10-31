import type { Traveller } from "@eth/travel";
import { z } from "zod";

const iata = z.string().regex(/^[A-Z]{3}$/, "3-letter IATA airport code");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** What the orchestrator understood from the user's request. */
export const TripSchema = z.object({
  origin: iata.describe("Airport the trip starts from (IATA code, e.g. BOM)"),
  destination: iata.describe("Destination airport (IATA code, e.g. GOI)"),
  destinationName: z.string().min(1).max(60).describe("Destination in words, e.g. Goa"),
  departDate: date.describe("Outbound date, YYYY-MM-DD"),
  // last night out: hotel checkout, and the return flight when returnFlight
  returnDate: date.describe(
    "Hotel checkout, and the return flight's date if there is one (YYYY-MM-DD)",
  ),
  returnFlight: z.boolean().describe("false only when the traveller wants a one-way flight"),
  adults: z.number().int().min(1).max(6).describe("Number of adult travellers (1–6)"),
  budgetInr: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Most they want to spend in rupees, or null"),
  nonRefundableOk: z
    .boolean()
    .describe("true only if they put price over being able to cancel or change"),
  hotelWishes: z
    .string()
    .max(120)
    .describe('What they want from the hotel, e.g. "quiet, beachfront"; "" if nothing'),
  notes: z.string().max(300).describe("Anything else the agent should know"),
});

export type Trip = z.infer<typeof TripSchema>;

// Not real numbers, but not sequential either: suppliers reject placeholder-looking phones.
const FAKE_PHONES = [
  "9820471638",
  "9867302915",
  "9930548127",
  "9819264073",
  "9892607451",
  "9821739506",
];

/** Clearly fake traveller #i for sandbox bookings (real profiles come from the app later). */
export function demoTraveller(i: number): Traveller {
  const names = ["Asha", "Rohan", "Meera", "Kabir", "Isha", "Arjun"];
  const female = i % 2 === 0;
  return {
    title: female ? "ms" : "mr",
    givenName: names[i % names.length] ?? "Test",
    familyName: "Traveller",
    gender: female ? "f" : "m",
    bornOn: `199${i % 10}-0${(i % 9) + 1}-15`,
    nationality: "IN",
    email: `traveller${i + 1}@example.com`,
    phoneCountryCode: "91",
    phone: FAKE_PHONES[i % FAKE_PHONES.length] ?? "9820471638",
  };
}

export const demoTravellers = (n: number) => Array.from({ length: n }, (_, i) => demoTraveller(i));
