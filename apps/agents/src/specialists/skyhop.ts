import type { DuffelBooking, DuffelClient, DuffelOffer } from "@eth/travel";
import { demoTravellers, type Trip, TripSchema } from "../trip";
import { describeItinerary } from "./flight-note";
import type { SpecialistDef } from "./server";
import { type FlightManageDeps, flightManagement } from "./skyhop-manage";

/**
 * SkyHop: finds and books the cheapest flight on Duffel (test mode), then manages it: move it to
 * another day (a paid "flights.change" job) or cancel it. Fee: 0.05 USDC.
 * `prefer`: in test mode, Duffel Airways ("ZZ") is the airline whose bookings can really be
 * changed and cancelled (sandbox fares from real airlines often fail), so it's taken if offered.
 */
export function skyhop(
  duffel: DuffelClient,
  manage?: FlightManageDeps & { me: string },
  prefer?: string,
): SpecialistDef<Trip, DuffelOffer, DuffelBooking> {
  const m = manage && flightManagement(manage, manage.me);
  return {
    name: "SkyHop",
    skill: "flights",
    title: "SkyHop — cheapest flight, booked via Duffel",
    description: "Searches airlines via Duffel and books the cheapest fare (test mode).",
    input: TripSchema,
    priceUnits: 50_000n,
    async quote({ input: trip }) {
      const offers = await duffel.searchFlights({
        origin: trip.origin,
        destination: trip.destination,
        date: trip.departDate,
        returnDate: trip.returnFlight ? trip.returnDate : undefined,
        adults: trip.adults,
      });
      const best = offers.find((o) => prefer && o.airline === prefer) ?? offers[0];
      if (!best)
        throw new Error(`No flights ${trip.origin}→${trip.destination} on ${trip.departDate}`);
      return {
        note: describeItinerary(best, `${best.total} ${best.currency}`),
        detail: best,
        itemTotal: Number(best.total),
        itemCurrency: best.currency,
      };
    },
    async work({ task, quoteKey, input: trip }, offer) {
      const booking = await duffel.bookFlight(offer, demoTravellers(trip.adults));
      // Remember who paid for what, so only that buyer can manage this booking later.
      manage?.store.set(booking.orderId, {
        bookingId: booking.orderId,
        task,
        quoteKey: quoteKey ?? "",
        bookingReference: booking.bookingReference,
      });
      return booking;
    },
    ...(m ? { extend: m.routes, followUps: { "flights.change": m.change as never } } : {}),
  };
}
