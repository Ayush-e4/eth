// Run an agent made with the agent kit: it lists itself on Arkiv, keeps the listing renewed,
// quotes, takes x402 payments through MandateRegistry and survives restarts.
//   pnpm --filter @eth/agents run-agent <slug>        (needs the facilitator: `serve` runs one)
import { NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS } from "@eth/mandates";
import { HttpFacilitator } from "@eth/x402";
import { serve } from "@hono/node-server";
import { jobStore } from "../../src/specialists/jobs";
import { createSpecialist, type SpecialistDef } from "../../src/specialists/server";
import { escrowMoves, jobsFile, paymentChecker, refunder } from "../agent-money";
import { keepListed } from "../keep-listed";
import { loadCustom, sourceOf } from "./custom-agents";

const slug = process.argv[2] ?? "";
const me = loadCustom()[slug];
if (!me) {
  console.error(
    `no agent "${slug}" yet: pnpm --filter @eth/agents new-agent ${slug || "<slug>"} …`,
  );
  process.exit(1);
}
const log = (line: string) =>
  console.log(`  · ${line.replace(/ark_(live|test)_[A-Za-z0-9]+/g, "ark_$1_…")}`); // no API keys
const mod = (await import(sourceOf(slug))) as {
  default: () => SpecialistDef<unknown, unknown, unknown>;
};
const identity = { key: me.key, evm: me.evm, hederaAccount: me.hederaAccount };
const agent = createSpecialist(mod.default(), {
  identity,
  baseUrl: process.env.AGENT_BASE_URL ?? `http://localhost:${me.port}`,
  facilitator: new HttpFacilitator(process.env.FACILITATOR_URL ?? "http://localhost:8402"),
  usdcTokenId: NETWORKS.testnet.usdcTokenId,
  executorId: DEPLOYMENTS.testnet.mandateRegistryId,
  refund: refunder(identity),
  escrow: escrowMoves(identity), // pay on delivery (ESCROW=off to take fees directly)
  jobs: jobStore(jobsFile(slug)),
  paymentState: paymentChecker(),
  log,
});
serve({ fetch: agent.app.fetch, port: me.port });
const left = agent.recover();
if (left) log(`picking up ${left} unfinished job(s)`);
const r = await agent.publish();
console.log(
  `${agent.name} on http://localhost:${me.port}: ${r.alreadyListed ? "already listed" : "listed"} on Arkiv`,
);
keepListed([{ name: agent.name, key: me.key }], log);
console.log("check it at /build in the app. Ctrl+C to stop.");
