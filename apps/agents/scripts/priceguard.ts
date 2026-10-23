// One round of PriceGuard: for each booking it watches, ask StayWise for today's best refundable
// price on the same stay; if it beats the traveller's signed limits, rebook (new first, then cancel
// the old) and invoice 20% of the saving on Arkiv. In production this runs on a schedule.
// Run: pnpm --filter @eth/agents priceguard [--simulate-drop 15]   (simulation: sandbox only)
import { log, requireEnv, startAgents, startFacilitator } from "./runtime";

requireEnv(["LITEAPI_KEY"]);
const args = process.argv.slice(2);
const i = args.indexOf("--simulate-drop");
const simulateDropPercent = i >= 0 ? Number(args[i + 1] ?? 15) : undefined;
if (simulateDropPercent !== undefined && !(process.env.LITEAPI_KEY ?? "").startsWith("sand_")) {
  throw new Error("--simulate-drop is for sandbox keys only");
}

const facilitator = await startFacilitator();
const agents = await startAgents(["staywise", "priceguard"], facilitator.client, {
  simulateDropPercent,
});
if (simulateDropPercent)
  log(`SIMULATION: StayWise pretends bookings cost ${simulateDropPercent}% more than paid`);
try {
  await agents.priceGuard?.checkOnce(log);
} finally {
  agents.stop();
  facilitator.stop();
}
process.exit(0);
