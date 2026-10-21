import type { LiteFlightBooking, LiteFlightOffer, LiteFlightsClient } from "@eth/travel";
import { demoTravellers } from "../trip";
import { describeItinerary } from "./flight-note";
import type { SpecialistDef } from "./server";

/**
 * AirNest: SkyHop's competitor. Same skill, different supplier (LiteAPI flights sandbox) and a
 * lower fee — so the orchestrator has to compare total cost, not just pick the cheaper agent.
 * Fee: 0.03 USDC.
 */
export function airnest(
  flights: LiteFlightsClient,
): SpecialistDef<LiteFlightOffer, LiteFlightBooking> {
  return {
    name: "AirNest",
    skill: "flights",
    title: "AirNest — budget flights, booked via LiteAPI",
    description: "Searches airlines via LiteAPI (Nuitee) and books the cheapest fare (sandbox).",
    priceUnits: 30_000n,
    async quote({ trip }) {
      const [best] = await flights.searchFlights({
        origin: trip.origin,
        destination: trip.destination,
        date: trip.departDate,
        returnDate: trip.returnFlight ? trip.returnDate : undefined,
        adults: trip.adults,
      });
      if (!best)
        throw new Error(`No flights ${trip.origin}→${trip.destination} on ${trip.departDate}`);
      return {
        note: describeItinerary(best, `${best.total.toLocaleString("en-IN")} ${best.currency}`),
        detail: best,
        itemTotal: best.total,
        itemCurrency: best.currency,
      };
    },
    async work({ trip }, offer) {
      return flights.book(offer, demoTravellers(trip.adults));
    },
  };
}
