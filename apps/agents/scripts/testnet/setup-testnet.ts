// Is everything AgentNet needs on the test networks still there? Run after a testnet reset (or
// any time): it checks each piece in order and says what's missing.
//   pnpm setup:testnet          check only (changes nothing)
//   pnpm setup:testnet --fix    also fix what can be fixed safely, and list the manual steps
// See docs/testnet-reset.md.
import { loadConfig } from "@eth/hedera";
import {
  agents,
  arkiv,
  type Check,
  identities,
  operator,
  registry,
  spendLog,
  usdc,
} from "./checks";
import { escrowGas } from "./gas";

const fix = process.argv.includes("--fix");
const config = loadConfig();
// In order: later steps need the earlier ones (an account to pay, USDC to hold, a contract…).
const steps = [
  () => operator(config),
  () => usdc(config),
  () => registry(config),
  () => spendLog(config),
  () => agents(config),
  () => escrowGas(config),
  () => arkiv(config),
  () => identities(),
];

const todo: string[] = [];
let failed = 0;
for (const step of steps) {
  const c: Check = await step().catch((err: unknown) => ({
    name: "check",
    ok: false,
    detail: String(err).slice(0, 200),
  }));
  console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  if (c.ok) continue;
  if (fix && c.auto) {
    const done = await c.auto().catch((err: unknown) => `fix failed: ${String(err).slice(0, 200)}`);
    console.log(`    → ${done}`);
    continue;
  }
  failed++;
  if (c.auto) todo.push(`${c.name}: run with --fix`);
  else if (c.manual) todo.push(`${c.name}: ${c.manual}`);
}

if (todo.length) {
  console.log("\nTo do:");
  for (const t of todo) console.log(`  - ${t}`);
}
console.log(
  failed
    ? `\n${failed} thing(s) need attention.`
    : fix
      ? "\nDone. Restart the market and the API so they pick up any new settings."
      : "\nEverything AgentNet needs is in place.",
);
process.exit(failed ? 1 : 0);
