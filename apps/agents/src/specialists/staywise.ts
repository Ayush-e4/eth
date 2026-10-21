import type { HotelBooking, HotelOffer, LiteApiClient } from "@eth/travel";
import { demoTraveller } from "../trip";
import type { SpecialistDef } from "./server";

/** StayWise: finds and books the cheapest hotel near the destination airport (LiteAPI sandbox). Fee: 0.04 USDC. */
export function staywise(lite: LiteApiClient): SpecialistDef<HotelOffer, HotelBooking> {
  return {
    name: "StayWise",
    skill: "hotels",
    title: "StayWise — best-value hotel, booked via LiteAPI",
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
        itemTotal: best.total,
        itemCurrency: best.currency,
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
          phone: `+${lead.phoneCountryCode}${lead.phone}`,
        },
        task,
      );
    },
  };
}
