// One-time: create identities for the orchestrator and the two specialist agents.
//   - flights + hotels each get a Hedera account (where they get paid) with an ECDSA key
//   - the orchestrator gets a signing key (it authorises mandate payments; it never holds funds)
//   - all three get a little GLM on Arkiv so they can write their own marketplace records
// Writes apps/agents/.agents.local.json (gitignored, mode 600). Safe to re-run: keeps existing.
// Run: pnpm --filter @eth/agents setup
import { existsSync, writeFileSync } from "node:fs";
import { ARKIV_CHAIN, arkivReader } from "@eth/arkiv";
import { createAccount, createClient, hashscanAccountUrl, loadConfig } from "@eth/hedera";
import { createWalletClient, type Hex, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IDENTITIES_PATH, type Identities, loadIdentities } from "../src/identities";

const config = loadConfig();
const operatorKey = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;

let ids: Identities;
if (existsSync(IDENTITIES_PATH)) {
  ids = loadIdentities();
  console.log("identities already exist — topping up GLM only");
} else {
  const hedera = createClient(config);
  const make = async (memo: string) => {
    const a = await createAccount(hedera, { initialHbar: 2, memo });
    console.log(`${memo}: ${a.accountId}  ${hashscanAccountUrl(config, a.accountId)}`);
    return {
      key: `0x${a.privateKey.replace(/^0x/, "")}` as Hex,
      evm: a.evmAddress as `0x${string}`,
      hederaAccount: a.accountId,
    };
  };
  const flights = await make("eth agent: SkyHop (flights)");
  const hotels = await make("eth agent: StayWise (hotels)");
  hedera.close();
  const orchestratorKey = generatePrivateKey();
  ids = {
    orchestrator: { key: orchestratorKey, evm: privateKeyToAccount(orchestratorKey).address },
    flights,
    hotels,
  };
  writeFileSync(IDENTITIES_PATH, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
  console.log(`wrote ${IDENTITIES_PATH} (mode 600, gitignored)`);
}

// Top up GLM so each agent can pay for its own Arkiv writes.
const reader = arkivReader();
const funder = createWalletClient({
  chain: ARKIV_CHAIN,
  transport: http(),
  account: privateKeyToAccount(operatorKey),
});
for (const [name, addr] of [
  ["orchestrator", ids.orchestrator.evm],
  ["flights", ids.flights.evm],
  ["hotels", ids.hotels.evm],
] as const) {
  const bal = await reader.getBalance({ address: addr });
  if (bal < parseEther("0.05")) {
    const hash = await funder.sendTransaction({ to: addr, value: parseEther("0.2") });
    await reader.waitForTransactionReceipt({ hash });
    console.log(`funded ${name} ${addr} with 0.2 GLM`);
  } else {
    console.log(`${name} ${addr} has GLM already`);
  }
}
