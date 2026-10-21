import type { DuffelBooking, DuffelClient, DuffelOffer } from "@eth/travel";
import { demoTravellers } from "../trip";
import { describeItinerary } from "./flight-note";
import type { SpecialistDef } from "./server";

/** SkyHop: finds and books the cheapest flight on Duffel (test mode). Fee: 0.05 USDC. */
export function skyhop(duffel: DuffelClient): SpecialistDef<DuffelOffer, DuffelBooking> {
  return {
    name: "SkyHop",
    skill: "flights",
    title: "SkyHop — cheapest flight, booked via Duffel",
    description: "Searches airlines via Duffel and books the cheapest fare (test mode).",
    priceUnits: 50_000n,
    async quote({ trip }) {
      const [best] = await duffel.searchFlights({
        origin: trip.origin,
        destination: trip.destination,
        date: trip.departDate,
        returnDate: trip.returnFlight ? trip.returnDate : undefined,
        adults: trip.adults,
      });
      if (!best)
        throw new Error(`No flights ${trip.origin}→${trip.destination} on ${trip.departDate}`);
      return {
        note: describeItinerary(best, `${best.total} ${best.currency}`),
        detail: best,
        itemTotal: Number(best.total),
        itemCurrency: best.currency,
      };
    },
    async work({ trip }, offer) {
      return duffel.bookFlight(offer, demoTravellers(trip.adults));
    },
  };
}
