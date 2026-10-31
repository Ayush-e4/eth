// What AgentNet needs on the test networks, one check each, with how to fix what's missing.
// Used by setup-testnet.ts. Fixes marked `auto` are safe to run; `manual` ones need a person
// (faucets have CAPTCHAs, the Hedera portal needs a login).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arkivReader, findAgents } from "@eth/arkiv";
import {
  associateToken,
  createAccount,
  createClient,
  createTopic,
  type HederaConfig,
  NETWORKS,
} from "@eth/hedera";
import { DEPLOYMENTS, ERC8004, Erc8004Client, hederaTestnet } from "@eth/mandates";
import { deployRegistry } from "@eth/mandates/deploy";
import { createPublicClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_SLUGS, IDENTITIES_PATH, type Identities } from "../../src/identities";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  auto?: () => Promise<string>; // a fix this script can do
  manual?: string; // a fix a person has to do
}

const net = NETWORKS.testnet;
const evm = createPublicClient({ chain: hederaTestnet, transport: http() });
const mirror = async <T>(path: string): Promise<T | null> => {
  const res = await fetch(`${net.mirrorUrl}/api/v1${path}`).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
};
const ARTIFACT = fileURLToPath(
  new URL(
    "../../../../packages/contracts/out/MandateRegistry.sol/MandateRegistry.json",
    import.meta.url,
  ),
);
const hasCode = async (address: `0x${string}`) =>
  ((await evm.getCode({ address }).catch(() => undefined)) ?? "0x") !== "0x";
const opKey = (c: HederaConfig) =>
  (c.operatorKey.startsWith("0x") ? c.operatorKey : `0x${c.operatorKey}`) as Hex;

export async function operator(c: HederaConfig): Promise<Check> {
  const a = await mirror<{ balance: { balance: number } }>(`/accounts/${c.operatorId}`);
  const hbar = (a?.balance.balance ?? 0) / 1e8;
  return {
    name: "Operator account",
    ok: !!a && hbar >= 50,
    detail: a ? `${c.operatorId}, ${hbar.toFixed(0)} HBAR` : `${c.operatorId} not found`,
    manual: a
      ? "Top up HBAR at portal.hedera.com (testnet)."
      : "Create an ECDSA testnet account at portal.hedera.com; set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env.",
  };
}

export async function usdc(c: HederaConfig): Promise<Check> {
  const token = await mirror<{ symbol: string }>(`/tokens/${net.usdcTokenId}`);
  if (!token)
    return {
      name: "Test USDC",
      ok: false,
      detail: `token ${net.usdcTokenId} not found`,
      manual:
        "Circle's test USDC has a new id after the reset: look it up at faucet.circle.com and set USDC_TOKEN_ID in .env.",
    };
  const held = await mirror<{ tokens: { balance: number }[] }>(
    `/accounts/${c.operatorId}/tokens?token.id=${net.usdcTokenId}`,
  );
  const row = held?.tokens[0];
  const units = row?.balance ?? 0;
  return {
    name: "Test USDC",
    ok: !!row && units >= 1_000_000,
    detail: row ? `${(units / 1e6).toFixed(2)} USDC on the operator` : "operator can't hold it yet",
    ...(row
      ? { manual: "Get test USDC for the operator at faucet.circle.com (Hedera testnet)." }
      : {
          auto: async () => {
            await associateToken(createClient(c), c.operatorId, c.operatorKey, net.usdcTokenId);
            return "operator can now hold test USDC; get some at faucet.circle.com";
          },
        }),
  };
}

export async function registry(c: HederaConfig): Promise<Check> {
  const at = DEPLOYMENTS.testnet.mandateRegistry;
  const ok = await hasCode(at);
  return {
    name: "MandateRegistry",
    ok,
    detail: ok ? `${at} (${DEPLOYMENTS.testnet.mandateRegistryId})` : `no contract at ${at}`,
    auto: async () => {
      if (!existsSync(ARTIFACT))
        spawnSync("forge", ["build"], {
          cwd: fileURLToPath(new URL("../../../../packages/contracts", import.meta.url)),
          stdio: "inherit",
        });
      const d = await deployRegistry(privateKeyToAccount(opKey(c)), ARTIFACT, net.mirrorUrl);
      return `deployed. Add to .env:\n    MANDATE_REGISTRY_ADDRESS=${d.address}\n    MANDATE_REGISTRY_ID=${d.contractId}`;
    },
  };
}

export async function spendLog(c: HederaConfig): Promise<Check> {
  const id = process.env.SPEND_LOG_TOPIC_ID;
  const ok = !!id && !!(await mirror(`/topics/${id}`));
  return {
    name: "Public spend log (HCS topic)",
    ok,
    detail: id ? (ok ? id : `${id} not found`) : "SPEND_LOG_TOPIC_ID not set",
    auto: async () => {
      const { topicId } = await createTopic(createClient(c), {
        memo: "AgentNet public spend log",
        submitKey: c.operatorKey,
      });
      return `created. Add to .env:\n    SPEND_LOG_TOPIC_ID=${topicId}`;
    },
  };
}

/** Each agent's Hedera account still exists and still belongs to its key (ids get reused). */
export async function agents(c: HederaConfig): Promise<Check> {
  if (!existsSync(IDENTITIES_PATH))
    return {
      name: "Agent accounts",
      ok: false,
      detail: "no identities yet",
      auto: async () => {
        spawnSync("pnpm", ["--filter", "@eth/agents", "identities"], { stdio: "inherit" });
        return "created (see above)";
      },
    };
  const ids = JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities;
  const gone: (typeof AGENT_SLUGS)[number][] = [];
  for (const slug of AGENT_SLUGS) {
    const a = ids.agents[slug];
    const found = await mirror<{ evm_address: string }>(`/accounts/${a.hederaAccount}`);
    if (found?.evm_address?.toLowerCase() !== a.evm.toLowerCase()) gone.push(slug);
  }
  return {
    name: "Agent accounts",
    ok: gone.length === 0,
    detail: gone.length ? `missing on Hedera: ${gone.join(", ")}` : `${AGENT_SLUGS.length} agents`,
    auto: async () => {
      // Same keys, new Hedera accounts: their Arkiv listings and ERC-8004 identities stay theirs.
      const client = createClient(c);
      for (const slug of gone) {
        const a = ids.agents[slug];
        const made = await createAccount(client, {
          privateKey: a.key,
          initialHbar: 2,
          memo: `eth agent: ${slug}`,
        });
        ids.agents[slug] = { ...a, hederaAccount: made.accountId };
      }
      writeFileSync(IDENTITIES_PATH, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
      return `recreated ${gone.join(", ")} with their same keys`;
    },
  };
}

/** Everyone who writes to Arkiv needs a little GLM there for fees. */
export async function arkiv(c: HederaConfig): Promise<Check> {
  const r = arkivReader();
  const head = await r.getBlockNumber().catch(() => null);
  if (head === null)
    return {
      name: "Arkiv (Rabdi)",
      ok: false,
      detail: "not reachable",
      manual: "Check ARKIV_API_KEY and the Rabdi network status.",
    };
  const ids = existsSync(IDENTITIES_PATH)
    ? (JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities)
    : null;
  const writers = [
    ["operator", privateKeyToAccount(opKey(c)).address],
    ...(ids
      ? [["concierge", ids.orchestrator.evm], ...AGENT_SLUGS.map((s) => [s, ids.agents[s].evm])]
      : []),
  ] as [string, `0x${string}`][];
  const empty: string[] = [];
  for (const [who, address] of writers)
    if ((await r.getBalance({ address }).catch(() => 0n)) === 0n) empty.push(`${who} ${address}`);
  return {
    name: "Arkiv (Rabdi)",
    ok: empty.length === 0,
    detail: empty.length
      ? `no GLM for: ${empty.join(", ")}`
      : `block ${head}, ${writers.length} writers funded`,
    manual: "Fund them from the Rabdi faucet (hub.arkiv.network); a little GLM each is plenty.",
  };
}

/** Agents' ERC-8004 identities on the official registry (not ours; it may not survive a reset). */
export async function identities(): Promise<Check> {
  if (!(await hasCode(ERC8004.identity)))
    return {
      name: "ERC-8004 identities",
      ok: false,
      detail: "the official registry isn't on testnet",
      manual:
        "Nothing to do until the ERC-8004 registries are redeployed; hiring works without them.",
    };
  const ids = existsSync(IDENTITIES_PATH)
    ? (JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identities)
    : null;
  const profiles = await findAgents(arkivReader()).catch(() => []);
  const erc = new Erc8004Client();
  const missing: string[] = [];
  for (const slug of AGENT_SLUGS) {
    const me = ids?.agents[slug].evm.toLowerCase();
    const p = profiles.find((x) => x.record.agent.toLowerCase() === me);
    const owner =
      p?.record.erc8004Id !== undefined
        ? await erc.ownerOf(p.record.erc8004Id).catch(() => null)
        : null;
    if (owner?.toLowerCase() !== me) missing.push(slug);
  }
  return {
    name: "ERC-8004 identities",
    ok: missing.length === 0,
    detail: missing.length
      ? `not registered: ${missing.join(", ")}`
      : `${AGENT_SLUGS.length} agents registered`,
    auto: async () => {
      spawnSync("pnpm", ["--filter", "@eth/agents", "erc8004"], { stdio: "inherit" });
      return `registered (agents must be listed on Arkiv first: run serve once)`;
    },
  };
}
