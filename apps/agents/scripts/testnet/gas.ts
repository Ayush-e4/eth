// Pay on delivery needs a little HBAR on both sides: agents mark jobs delivered (and refund or
// claim) from their own accounts, and the concierge releases fees. This check tops them up.
import { existsSync, readFileSync } from "node:fs";
import { createClient, type HederaConfig, NETWORKS, transferHbar } from "@eth/hedera";
import { hederaTestnet } from "@eth/mandates";
import { createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IDENTITIES_PATH, type Identities } from "../../src/identities";
import { loadCustom } from "../kit/custom-agents";
import type { Check } from "./checks";

const LOW = 2; // HBAR; a delivery, refund or release costs a few hundredths
const TOP_UP_TO = 10;

const balanceOf = async (account: string) => {
  const res = await fetch(`${NETWORKS.testnet.mirrorUrl}/api/v1/accounts/${account}`).catch(
    () => null,
  );
  if (!res?.ok) return 0; // no account yet (the concierge's is made by its first top-up)
  return ((await res.json()) as { balance: { balance: number } }).balance.balance / 1e8;
};

export async function escrowGas(c: HederaConfig): Promise<Check> {
  if (!existsSync(IDENTITIES_PATH))
    return { name: "HBAR for pay on delivery", ok: false, detail: "no identities yet" };
  const ids = JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities;
  const who: [string, string][] = [
    ["concierge", ids.orchestrator.evm], // only an EVM address: its account comes with its HBAR
    ...Object.entries(ids.agents).map(([n, a]): [string, string] => [n, a.hederaAccount]),
    ...Object.entries(loadCustom()).map(([n, a]): [string, string] => [n, a.hederaAccount]),
  ];
  const low: [string, string, number][] = [];
  for (const [name, account] of who) {
    const hbar = await balanceOf(account);
    if (hbar < LOW) low.push([name, account, hbar]);
  }
  return {
    name: "HBAR for pay on delivery",
    ok: low.length === 0,
    detail: low.length
      ? `low: ${low.map(([n, , h]) => `${n} ${h.toFixed(2)}`).join(", ")}`
      : `${who.length} accounts have ≥${LOW} HBAR`,
    auto: async () => {
      const client = createClient(c);
      for (const [name, account, hbar] of low)
        await transferHbar(client, {
          from: c.operatorId,
          to: account,
          hbar: Math.ceil(TOP_UP_TO - hbar),
          memo: `eth: gas for ${name}`,
        });
      // HBAR sent to a bare EVM address makes a "hollow" account; its first transaction, signed
      // with its key, completes it. Do that now rather than on the first real release.
      if (low.some(([n]) => n === "concierge")) await complete(ids.orchestrator.key);
      return `topped up ${low.map(([n]) => n).join(", ")} to ~${TOP_UP_TO} HBAR`;
    },
  };
}

async function complete(key: Hex) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http() });
  const hash = await wallet.sendTransaction({ to: account.address, value: 0n });
  await createPublicClient({ chain: hederaTestnet, transport: http() }).waitForTransactionReceipt({
    hash,
  });
}
