import type { DuffelClient, FlightBooking, FlightOffer } from "@eth/travel";
import { demoTravellers } from "../trip";
import type { SpecialistDef } from "./server";

/** SkyHop: finds and books the cheapest flight on Duffel (test mode). Fee: 0.05 USDC. */
export function flightsAgent(duffel: DuffelClient): SpecialistDef<FlightOffer, FlightBooking> {
  return {
    name: "SkyHop",
    skill: "flights",
    title: "Search + book the cheapest flight",
    description: "Searches airlines via Duffel and books the cheapest fare (sandbox).",
    priceUnits: 50_000n,
    async quote({ trip }) {
      const [best] = await duffel.searchFlights({
        origin: trip.origin,
        destination: trip.destination,
        date: trip.departDate,
        adults: trip.adults,
      });
      if (!best)
        throw new Error(`No flights ${trip.origin}→${trip.destination} on ${trip.departDate}`);
      const time = best.departAt.slice(11, 16);
      return {
        note: `${best.carrier} ${best.origin}→${best.destination} ${trip.departDate} ${time}, ${best.stops ? `${best.stops} stop` : "nonstop"}, ${best.total} ${best.currency}`,
        detail: best,
      };
    },
    async work({ trip }, offer) {
      return duffel.bookFlight(offer, demoTravellers(trip.adults));
    },
  };
}
