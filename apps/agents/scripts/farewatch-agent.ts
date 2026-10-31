// FareWatch as the market runs it: LiteAPI flights (sandbox), its watches in a gitignored file.
//   FAREWATCH_EVERY_MIN   minutes between checks (default 15)
//   FAREWATCH_SIMULATE=1  allow made-up drops for demos (always labelled SIMULATED)
import { arkivReader } from "@eth/arkiv";
import { LiteFlightsClient } from "@eth/travel";
import { dataFile } from "../src/data-dir";
import { farewatch, type Watch } from "../src/specialists/farewatch";
import { JsonStore } from "../src/store";

const STORE = dataFile(".farewatch.local.json");

export function farewatchAgent() {
  const flights = new LiteFlightsClient(process.env.LITEAPI_KEY ?? "");
  return farewatch({
    search: (q) => flights.searchFlights(q),
    store: new JsonStore<Watch>(STORE),
    arkiv: arkivReader(),
    everyMs: Number(process.env.FAREWATCH_EVERY_MIN ?? 15) * 60_000,
    simulate: process.env.FAREWATCH_SIMULATE === "1",
  });
}
