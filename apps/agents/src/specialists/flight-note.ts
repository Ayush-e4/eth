import type { FlightLeg } from "@eth/travel";

/** "IndiGo 6E5321 BOM→GOI 30 Oct 07:10, nonstop" — one line per leg for quotes and receipts. */
export function describeLeg(leg: FlightLeg): string {
  const day = new Date(`${leg.departAt.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const flight = leg.flightNumber ? ` ${leg.flightNumber}` : "";
  const stops = leg.stops ? `${leg.stops} stop${leg.stops > 1 ? "s" : ""}` : "nonstop";
  return `${leg.carrier}${flight} ${leg.origin}→${leg.destination} ${day} ${leg.departAt.slice(11, 16)}, ${stops}`;
}

/** Outbound (+ return) legs and the price for the whole itinerary. */
export function describeItinerary(
  o: { outbound: FlightLeg; inbound?: FlightLeg },
  price: string,
): string {
  const legs = o.inbound
    ? `${describeLeg(o.outbound)} · return ${describeLeg(o.inbound)}`
    : describeLeg(o.outbound);
  return `${legs} — ${price}${o.inbound ? " round trip" : ""}`;
}
