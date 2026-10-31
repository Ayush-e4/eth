import type {
  HotelBooking,
  HotelMatch,
  HotelOffer,
  HotelPrebook,
  LiteApiClient,
} from "@eth/travel";
import { demoTraveller, type Trip, TripSchema } from "../trip";
import type { SpecialistDef } from "./server";
import { hotelChangeJob, manageRoutes } from "./staywise-manage";
import { type RepriceDeps, repriceRoutes } from "./staywise-reprice";

/** A hotel quote that is already locked with the supplier, so what's paid for can be booked. */
export interface FirmHotelQuote {
  offer: HotelOffer;
  prebook: HotelPrebook;
}

const TRIES = 3; // cheapest rooms to try locking before giving up
const STRONG = 0.75; // semantic match scores: prefer strong matches, accept good ones
const GOOD = 0.55;

/**
 * Which hotels to price. With wishes ("quiet, beachfront") LiteAPI's search-by-meaning picks them:
 * strong matches if any have rooms, else good ones. Without wishes: everything near the airport.
 */
async function candidates(lite: LiteApiClient, trip: Trip, refundableOnly: boolean) {
  const stay = {
    checkin: trip.departDate,
    checkout: trip.returnDate,
    adults: trip.adults,
    refundableOnly,
  };
  if (trip.hotelWishes) {
    const matches = await lite
      .semanticSearch(`${trip.hotelWishes} hotel in ${trip.destinationName}`, 12)
      .catch(() => [] as HotelMatch[]);
    for (const min of [STRONG, GOOD]) {
      const picked = matches.filter((m) => m.score >= min);
      if (!picked.length) continue;
      const offers = await lite.searchHotels({ ...stay, hotelIds: picked.map((m) => m.hotelId) });
      if (offers.length) {
        const byId = new Map(picked.map((m) => [m.hotelId, m]));
        return { offers, matchOf: (id: string) => byId.get(id) };
      }
    }
  }
  const offers = await lite.searchHotels({ ...stay, iataCode: trip.destination });
  return { offers, matchOf: (_id: string): HotelMatch | undefined => undefined };
}

/**
 * StayWise: books the best-value hotel for the traveller's wishes (LiteAPI sandbox).
 * Firm quotes: it locks the room (prebook) BEFORE quoting, falling back to the next-cheapest
 * room if one can't be locked — so failures happen before the buyer pays, not after.
 * Fee: 0.04 USDC.
 */
export function staywise(
  lite: LiteApiClient,
  manage?: Omit<RepriceDeps, "lite">,
): SpecialistDef<Trip, FirmHotelQuote, HotelBooking> {
  return {
    name: "StayWise",
    skill: "hotels",
    title: "StayWise — best-value hotel, booked via LiteAPI",
    description: "Searches hotels via LiteAPI, locks the price, books it (sandbox). Firm quotes.",
    input: TripSchema,
    priceUnits: 40_000n,
    async quote({ input: trip }) {
      // Refundable unless the traveller said price matters more: changes and refunds stay possible.
      let found = await candidates(lite, trip, !trip.nonRefundableOk);
      const noRefundable = !trip.nonRefundableOk && !found.offers.length;
      if (noRefundable) found = await candidates(lite, trip, false);
      const { offers, matchOf } = found;
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
        const match = matchOf(offer.hotelId);
        const fit = trip.hotelWishes
          ? match
            ? ` · matches "${trip.hotelWishes}" (${match.locationType ?? "match"}, ${match.score.toFixed(2)})`
            : ` · no hotel matching "${trip.hotelWishes}" had rooms; cheapest instead`
          : "";
        const why = noRefundable ? " · no refundable rate was available" : "";
        return {
          note: `${offer.hotelName} — ${offer.roomName}${board}${cancel}, ${prebook.total.toLocaleString("en-IN")} ${prebook.currency} total (price locked)${fit}${why}`,
          detail: { offer, prebook },
          itemTotal: prebook.total,
          itemCurrency: prebook.currency,
        };
      }
      throw new Error(`Couldn't lock any of the ${TRIES} cheapest rooms: ${failures.join("; ")}`);
    },
    async work({ task, quoteKey, input: trip }, { offer, prebook }) {
      const lead = demoTraveller(0);
      const booking = await lite.book(
        prebook.prebookId,
        {
          firstName: lead.givenName,
          lastName: lead.familyName,
          email: lead.email,
          phone: `+${lead.phoneCountryCode}${lead.phone}`,
        },
        task,
      );
      // Remember who paid for what, so only that buyer can manage this booking later.
      manage?.store.set(booking.bookingId, {
        bookingId: booking.bookingId,
        task,
        quoteKey: quoteKey ?? "",
        hotelId: offer.hotelId,
        adults: trip.adults,
      });
      return booking;
    },
    extend: manage
      ? (app, kit) => {
          manageRoutes(manage)(app, kit);
          repriceRoutes({ ...manage, lite })(app, kit);
        }
      : undefined,
    // Changing dates or guests from the chat: a paid "hotels.change" job through /work.
    ...(manage?.me
      ? { followUps: { "hotels.change": hotelChangeJob(manage, manage.me) as never } }
      : {}),
  };
}
