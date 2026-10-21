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
  returnDate: date,
  adults: z.number().int().min(1).max(6),
  budgetInr: z.number().int().positive().nullable(),
  notes: z.string().max(300),
});

export type Trip = z.infer<typeof TripSchema>;

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
    email: `traveller${i + 1}@example.com`,
    phone: `+9198765432${String(i).padStart(2, "0")}`,
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
