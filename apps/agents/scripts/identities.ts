// Create identities for the orchestrator and every specialist agent (only the missing ones).
//   - each specialist gets a Hedera account (where it gets paid) with an ECDSA key
//   - the orchestrator gets a signing key (it authorises mandate payments; it never holds funds)
//   - all of them get a little GLM on Arkiv so they can write their own marketplace records
// Writes apps/agents/.agents.local.json (gitignored, mode 600). Safe to re-run: keeps existing.
// Run: pnpm --filter @eth/agents identities
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ARKIV_CHAIN, arkivReader } from "@eth/arkiv";
import { createAccount, createClient, hashscanAccountUrl, loadConfig } from "@eth/hedera";
import { createWalletClient, type Hex, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AGENT_SLUGS,
  IDENTITIES_PATH,
  IdentitiesSchema,
  type SpecialistIdentity,
} from "../src/identities";

const config = loadConfig();
const operatorKey = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;

const existing = existsSync(IDENTITIES_PATH)
  ? (JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as {
      orchestrator?: { key: Hex; evm: `0x${string}` };
      agents?: Record<string, SpecialistIdentity>;
    })
  : {};
const orchestratorKey = existing.orchestrator?.key ?? generatePrivateKey();
const agents: Record<string, SpecialistIdentity> = { ...existing.agents };

const missing = AGENT_SLUGS.filter((slug) => !agents[slug]);
if (missing.length) {
  const hedera = createClient(config);
  for (const slug of missing) {
    const a = await createAccount(hedera, { initialHbar: 2, memo: `eth agent: ${slug}` });
    console.log(`${slug}: ${a.accountId}  ${hashscanAccountUrl(config, a.accountId)}`);
    agents[slug] = {
      key: `0x${a.privateKey.replace(/^0x/, "")}` as Hex,
      evm: a.evmAddress as `0x${string}`,
      hederaAccount: a.accountId,
    };
  }
  hedera.close();
}

const ids = IdentitiesSchema.parse({
  orchestrator: { key: orchestratorKey, evm: privateKeyToAccount(orchestratorKey).address },
  agents,
});
writeFileSync(IDENTITIES_PATH, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
console.log(`identities in ${IDENTITIES_PATH} (mode 600, gitignored)`);

// Top up GLM so each agent can pay for its own Arkiv writes.
const reader = arkivReader();
const funder = createWalletClient({
  chain: ARKIV_CHAIN,
  transport: http(),
  account: privateKeyToAccount(operatorKey),
});
const wallets: [string, `0x${string}`][] = [
  ["orchestrator", ids.orchestrator.evm],
  ...AGENT_SLUGS.map((slug): [string, `0x${string}`] => [slug, ids.agents[slug].evm]),
];
for (const [name, addr] of wallets) {
  const bal = await reader.getBalance({ address: addr });
  if (bal < parseEther("0.05")) {
    const hash = await funder.sendTransaction({ to: addr, value: parseEther("0.2") });
    await reader.waitForTransactionReceipt({ hash });
    console.log(`funded ${name} ${addr} with 0.2 GLM`);
  } else {
    console.log(`${name} ${addr} has GLM already`);
  }
}
