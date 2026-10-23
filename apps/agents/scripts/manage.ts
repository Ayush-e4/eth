// Come back to a booked trip: "add a night", "put Rohan's name on the hotel", "cancel the hotel".
// Claude talks to StayWise (signed as the buyer), pays its small fees through a new mandate, and
// asks you before anything that costs more or loses money.
// Run: pnpm --filter @eth/agents manage "your change" [--yes | --no] [--demo-pay-simulated]
//   --yes/--no answer for you (default: ask in the terminal); --demo-pay-simulated lets a sandbox
//   demo pay PriceGuard for a SIMULATED saving (normally such invoices are refused).
import { createInterface } from "node:readline/promises";
import { privateKeyToAccount } from "viem/accounts";
import { runChangeAgent } from "../src/orchestrator/change-agent";
import { latestTrip, tripStore } from "../src/trips";
import {
  createMandate,
  ids,
  log,
  orchestratorDeps,
  printExplanation,
  requireEnv,
  startAgents,
  startFacilitator,
} from "./runtime";

requireEnv(["ANTHROPIC_API_KEY", "LITEAPI_KEY"]);
const args = process.argv.slice(2);
const request = args.find((a) => !a.startsWith("--"));
if (!request) throw new Error('Say what to change, e.g. manage "add one more night to the hotel"');
const auto = args.includes("--yes") ? "yes" : args.includes("--no") ? "no" : undefined;

const store = tripStore();
const record = latestTrip(store);
if (!record) throw new Error("No saved trip yet — run the demo first.");
console.log(
  `trip ${record.task}: ${record.trip.origin}→${record.trip.destination} ${record.trip.departDate}…${record.trip.returnDate}`,
);
for (const h of record.hires)
  console.log(`   ${h.skill}: ${h.status} ${h.bookingId ?? ""} — ${h.quoteNote}`);

const facilitator = await startFacilitator();
const agents = await startAgents(["staywise", "priceguard"], facilitator.client);
// Room for StayWise's small fees and one PriceGuard success fee (capped at 5 USDC per invoice).
const { mandateId, mc } = await createMandate(5_200_000n, 5_000_000n, ["staywise", "priceguard"]);
const deps = await orchestratorDeps(mandateId, mc, 5_000_000n);

async function ask(question: string): Promise<string> {
  if (auto) {
    log(`(auto-answer "${auto}") ${question}`);
    return auto;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n  ? ${question}\n  > `);
  rl.close();
  return answer;
}

console.log(`\nrequest: "${request}"`);
const run = await runChangeAgent(request, record, {
  ...deps,
  signer: privateKeyToAccount(ids.orchestrator.key),
  ask,
  save: (r) => store.set(r.task, r),
  demoPaySimulated: args.includes("--demo-pay-simulated"),
});
if (run.explanation) printExplanation(run.explanation);
for (const line of run.record.history) console.log(`   ⋯ ${line}`);
console.log(
  `   mandate #${mandateId} remaining: ${Number(await mc.remaining(mandateId)) / 1e6} USDC`,
);

agents.stop();
facilitator.stop();
process.exit(run.failures.length ? 1 : 0);
