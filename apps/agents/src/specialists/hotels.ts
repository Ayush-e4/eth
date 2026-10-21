import type { HotelBooking, HotelOffer, LiteApiClient } from "@eth/travel";
import { demoTraveller } from "../trip";
import type { SpecialistDef } from "./server";

/** StayWise: finds and books the cheapest hotel near the destination airport (LiteAPI sandbox). Fee: 0.04 USDC. */
export function hotelsAgent(lite: LiteApiClient): SpecialistDef<HotelOffer, HotelBooking> {
  return {
    name: "StayWise",
    skill: "hotels",
    title: "Find + book the best-value hotel",
    description: "Searches hotels via LiteAPI and books the cheapest good option (sandbox).",
    priceUnits: 40_000n,
    async quote({ trip }) {
      const [best] = await lite.searchHotels({
        iataCode: trip.destination,
        checkin: trip.departDate,
        checkout: trip.returnDate,
        adults: trip.adults,
      });
      if (!best) throw new Error(`No hotels near ${trip.destination} for those dates`);
      const board = best.board ? `, ${best.board}` : "";
      return {
        note: `${best.hotelName} — ${best.roomName}${board}, ${best.total.toLocaleString("en-IN")} ${best.currency} total`,
        detail: best,
      };
    },
    async work({ task }, offer) {
      const lead = demoTraveller(0);
      const prebookId = await lite.prebook(offer.offerId);
      return lite.book(
        prebookId,
        {
          firstName: lead.givenName,
          lastName: lead.familyName,
          email: lead.email,
          phone: lead.phone,
        },
        task,
      );
    },
  };
}
