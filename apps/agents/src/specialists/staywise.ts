import type { HotelBooking, HotelOffer, HotelPrebook, LiteApiClient } from "@eth/travel";
import { demoTraveller } from "../trip";
import type { SpecialistDef } from "./server";

/** A hotel quote that is already locked with the supplier, so what's paid for can be booked. */
export interface FirmHotelQuote {
  offer: HotelOffer;
  prebook: HotelPrebook;
}

const TRIES = 3; // cheapest rooms to try locking before giving up

/**
 * StayWise: books the best-value hotel near the destination airport (LiteAPI sandbox).
 * Firm quotes: it locks the room (prebook) BEFORE quoting, falling back to the next-cheapest
 * room if one can't be locked — so failures happen before the buyer pays, not after.
 * Fee: 0.04 USDC.
 */
export function staywise(lite: LiteApiClient): SpecialistDef<FirmHotelQuote, HotelBooking> {
  return {
    name: "StayWise",
    skill: "hotels",
    title: "StayWise — best-value hotel, booked via LiteAPI",
    description: "Searches hotels via LiteAPI, locks the price, books it (sandbox). Firm quotes.",
    priceUnits: 40_000n,
    async quote({ trip }) {
      const offers = await lite.searchHotels({
        iataCode: trip.destination,
        checkin: trip.departDate,
        checkout: trip.returnDate,
        adults: trip.adults,
      });
      if (!offers.length) throw new Error(`No hotels near ${trip.destination} for those dates`);
      const failures: string[] = [];
      for (const offer of offers.slice(0, TRIES)) {
        const prebook = await lite.prebook(offer.offerId).catch((e: unknown) => {
          failures.push(`${offer.hotelName}: ${String(e).slice(0, 120)}`);
          return undefined;
        });
        if (!prebook) continue;
        const board = offer.board ? `, ${offer.board}` : "";
        const cancel =
          prebook.refundable === undefined
            ? ""
            : prebook.refundable
              ? ", free cancellation"
              : ", non-refundable";
        return {
          note: `${offer.hotelName} — ${offer.roomName}${board}${cancel}, ${prebook.total.toLocaleString("en-IN")} ${prebook.currency} total (price locked)`,
          detail: { offer, prebook },
          itemTotal: prebook.total,
          itemCurrency: prebook.currency,
        };
      }
      throw new Error(`Couldn't lock any of the ${TRIES} cheapest rooms: ${failures.join("; ")}`);
    },
    async work({ task }, { prebook }) {
      const lead = demoTraveller(0);
      return lite.book(
        prebook.prebookId,
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
