// End-to-end: "Plan a Goa weekend" → the orchestrator finds agents on Arkiv, makes two flights
// agents compete on total cost, hires the winner and a hotels agent, pays each through
// MandateRegistry over x402, they book in sandbox, and Claude explains every spend.
// The trip is saved so `manage` can change or cancel it later.
// Needs ANTHROPIC_API_KEY, DUFFEL_ACCESS_TOKEN (duffel_test_…) and LITEAPI_KEY (sand_…) in .env.
// Run: pnpm --filter @eth/agents demo ["your request"] [--autopilot]
import { ARKIV_EXPLORER } from "@eth/arkiv";
import { runTripAgent } from "../src/orchestrator/agent";
import { runTrip } from "../src/orchestrator/run";
import { toRecord, tripStore } from "../src/trips";
import {
  createMandate,
  log,
  orchestratorDeps,
  printExplanation,
  requireEnv,
  startAgents,
  startFacilitator,
  tx,
} from "./runtime";

requireEnv(["ANTHROPIC_API_KEY", "DUFFEL_ACCESS_TOKEN", "LITEAPI_KEY"]);
const args = process.argv.slice(2);
const autopilot = args.includes("--autopilot"); // fixed flow, no agent loop
const request =
  args.find((a) => !a.startsWith("--")) ??
  "Plan a weekend in Goa for 2 of us, flying from Mumbai next Friday and back on Sunday. Budget ₹40,000.";

const facilitator = await startFacilitator();
console.log("1. agents online — SkyHop :8411 + AirNest :8413 (flights), StayWise :8412 (hotels)");
const agents = await startAgents(["skyhop", "airnest", "staywise"], facilitator.client);

console.log("2. the traveller's budget for agent fees");
const { mandateId, mc } = await createMandate(300_000n, 100_000n, [
  "skyhop",
  "airnest",
  "staywise",
]);

console.log(`3. request: "${request}" (${autopilot ? "autopilot" : "Claude agent"})`);
const deps = await orchestratorDeps(mandateId, mc);
const run = autopilot
  ? await runTrip(request, deps)
  : await runTripAgent(request, deps, { liteApiKey: process.env.LITEAPI_KEY });

console.log("\n4. result");
printExplanation(run.explanation);
for (const h of run.hires) {
  console.log(`     ${h.skill}: ${tx(h.hederaTx)}  job ${ARKIV_EXPLORER.entity(h.jobKey)}`);
}
console.log(
  `   mandate #${mandateId} remaining: ${Number(await mc.remaining(mandateId)) / 1e6} USDC`,
);
if (run.hires.length) {
  tripStore().set(run.task, toRecord(run));
  log(`trip saved as ${run.task} — change it later with: pnpm --filter @eth/agents manage "…"`);
}

agents.stop();
facilitator.stop();
process.exit(run.failures.length ? 1 : 0);
