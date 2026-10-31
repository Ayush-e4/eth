// Keeps the market running for the app: the x402 facilitator plus SkyHop, AirNest, StayWise,
// PriceGuard and TripMint, each listed on Arkiv. The API's concierge hires them while this runs.
// Run: pnpm --filter @eth/agents serve   (Ctrl+C stops everything)
import { requireEnv, startAgents, startFacilitator } from "./runtime";

requireEnv(["DUFFEL_ACCESS_TOKEN", "LITEAPI_KEY"]);

console.log("starting the facilitator (:8402) …");
const facilitator = await startFacilitator();
console.log(
  "starting agents: SkyHop :8411, StayWise :8412, AirNest :8413, PriceGuard :8414, TripMint :8415, FareWatch :8416",
);
const agents = await startAgents(
  ["skyhop", "airnest", "staywise", "priceguard", "tripmint", "farewatch"],
  facilitator.client,
);
console.log("market is up. Ctrl+C to stop.");

const stop = () => {
  agents.stop();
  facilitator.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
