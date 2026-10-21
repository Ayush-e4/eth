// Read-only check that the sandbox travel keys work: searches only, no bookings, no payments.
// Run: pnpm --filter @eth/agents probe [ORIGIN DEST YYYY-MM-DD]
import { DuffelClient, LiteApiClient, LiteFlightsClient } from "@eth/travel";
import { describeItinerary } from "../src/specialists/flight-note";

const [origin = "BOM", destination = "GOI", date = isoDaysFromNow(14)] = process.argv.slice(2);
const returnDate = isoDaysFromNow(16);
const checkout = returnDate;

function isoDaysFromNow(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function check(name: string, run: () => Promise<string[]>) {
  const t = Date.now();
  try {
    const lines = await run();
    console.log(`✔ ${name} (${Date.now() - t} ms)`);
    for (const l of lines) console.log(`    ${l}`);
  } catch (err) {
    console.log(`✘ ${name}: ${String(err).slice(0, 400)}`);
  }
}

console.log(`searching ${origin}→${destination} on ${date} (hotels ${date}…${checkout})`);
await check("Duffel flights (test mode)", async () => {
  const offers = await new DuffelClient(process.env.DUFFEL_ACCESS_TOKEN ?? "").searchFlights({
    origin,
    destination,
    date,
    returnDate,
    adults: 2,
  });
  return [
    `${offers.length} round-trip offers`,
    ...offers.slice(0, 3).map((o) => describeItinerary(o, `${o.total} ${o.currency}`)),
  ];
});
await check("LiteAPI flights (sandbox)", async () => {
  const offers = await new LiteFlightsClient(process.env.LITEAPI_KEY ?? "").searchFlights({
    origin,
    destination,
    date,
    returnDate,
    adults: 2,
  });
  return [
    `${offers.length} round-trip offers`,
    ...offers.slice(0, 3).map((o) => describeItinerary(o, `${o.total} ${o.currency}`)),
  ];
});
await check("LiteAPI hotels (sandbox)", async () => {
  const offers = await new LiteApiClient(process.env.LITEAPI_KEY ?? "").searchHotels({
    iataCode: destination,
    checkin: date,
    checkout,
    adults: 2,
  });
  return [
    `${offers.length} hotels`,
    ...offers.slice(0, 3).map((o) => `${o.hotelName} — ${o.roomName} ${o.total} ${o.currency}`),
  ];
});
