import type { Traveller } from "@eth/travel";
import { z } from "zod";

const iata = z.string().regex(/^[A-Z]{3}$/, "3-letter IATA airport code");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** What the orchestrator understood from the user's request. */
export const TripSchema = z.object({
  origin: iata,
  destination: iata,
  destinationName: z.string().min(1).max(60),
  departDate: date,
  returnDate: date, // last night out: hotel checkout, and the return flight when returnFlight
  returnFlight: z.boolean(), // false only when the traveller wants a one-way flight
  adults: z.number().int().min(1).max(6),
  budgetInr: z.number().int().positive().nullable(),
  hotelWishes: z.string().max(120), // what the traveller wants from the hotel, e.g. "quiet, beachfront"; "" if nothing
  notes: z.string().max(300),
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

/** Request body both specialists accept on /quote and /work. */
export const TaskBodySchema = z.object({
  task: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  trip: TripSchema,
  quoteKey: z.string().optional(),
});

export type TaskBody = z.infer<typeof TaskBodySchema>;
