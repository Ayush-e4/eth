// Give every agent an ERC-8004 identity on Hedera testnet (the official shared registry) and link
// it from the agent's Arkiv profile. Each agent registers itself, with its own key, so it owns
// its identity token. Safe to re-run: agents already linked are skipped.
// Run: pnpm --filter @eth/agents erc8004
import { ARKIV_EXPLORER, arkivReader, arkivWriter, findAgents, setAgentIdentity } from "@eth/arkiv";
import { dataUri, ERC8004, Erc8004Client, registrationFile } from "@eth/mandates";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_SLUGS, loadIdentities } from "../src/identities";

const ids = loadIdentities();
const erc = new Erc8004Client();
const profiles = await findAgents(arkivReader());
const hashscan = (tx: string) => `https://hashscan.io/testnet/transaction/${tx}`;

for (const slug of AGENT_SLUGS) {
  const me = ids.agents[slug];
  const profile = profiles.find((p) => p.record.agent.toLowerCase() === me.evm.toLowerCase());
  if (!profile) {
    console.log(`${slug}: not listed on Arkiv yet (run serve once), skipped`);
    continue;
  }
  if (profile.record.erc8004Id !== undefined) {
    const owner = await erc.ownerOf(profile.record.erc8004Id);
    const ok = owner.toLowerCase() === me.evm.toLowerCase();
    console.log(
      `${slug}: already ERC-8004 #${profile.record.erc8004Id}${ok ? "" : " (owner mismatch!)"}`,
    );
    continue;
  }
  const account = privateKeyToAccount(me.key);
  const base = {
    name: profile.record.name,
    description: profile.record.description,
    endpoint: profile.record.endpoint,
    arkivProfile: ARKIV_EXPLORER.entity(profile.key),
    hederaAccount: me.hederaAccount,
  };
  const { agentId, receipt } = await erc.register(account, dataUri(registrationFile(base)));
  // Now that it has an id, the file can name its own registration (registration-v1).
  await erc.setAgentURI(account, agentId, dataUri(registrationFile({ ...base, agentId })));
  await setAgentIdentity(arkivWriter(me.key), profile.key, agentId);
  console.log(
    `${slug}: ERC-8004 #${agentId} on ${ERC8004.identity}  ${hashscan(receipt.transactionHash)}`,
  );
}
