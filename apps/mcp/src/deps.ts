import { buy, collectQuotes, fetchInrRates, type HireDeps } from "@eth/agents/hiring";
import { arkivReader, arkivWriter, findAgents, findListings } from "@eth/arkiv";
import { NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS, hederaTestnet, MandateClient } from "@eth/mandates";
import { createPayingFetch, MirrorResolver } from "@eth/x402";
import { privateKeyToAccount } from "viem/accounts";
import type { McpConfig } from "./config";
import type { MarketAgent, ToolDeps } from "./tools";

// stdout is the MCP channel; anything human-readable goes to stderr.
const log = (line: string) => process.stderr.write(`${line}\n`);

/** Profiles on Arkiv joined to their live listings (an agent with no listing can't be hired). */
export async function listedAgents(skill?: string): Promise<MarketAgent[]> {
  const r = arkivReader();
  const profiles = await findAgents(r, skill ? { skill } : {});
  const skills = [...new Set(profiles.map((p) => p.record.skill))];
  const listings = (await Promise.all(skills.map((s) => findListings(r, { skill: s })))).flat();
  const seen = new Set<string>();
  const out: MarketAgent[] = [];
  for (const p of profiles) {
    const id = `${p.record.agent.toLowerCase()}:${p.record.skill}`;
    const l = listings.find(
      (x) =>
        x.record.agent.toLowerCase() === p.record.agent.toLowerCase() &&
        x.record.skill === p.record.skill,
    );
    if (!l || seen.has(id)) continue;
    seen.add(id);
    out.push({
      name: p.record.name,
      skill: p.record.skill,
      title: l.record.title,
      description: p.record.description,
      feeUnits: l.record.priceUnits,
      agent: p.record.agent,
      endpoint: l.record.endpoint,
    });
  }
  return out;
}

/** The real wiring: Arkiv for the market, x402 on Hedera for payments, under the mandate. */
export function realDeps(config: McpConfig | null): ToolDeps {
  const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
  const base = async () => ({
    arkiv: arkivReader(),
    evm: mc.publicClient,
    registry: DEPLOYMENTS.testnet.mandateRegistry,
    inrRates: await fetchInrRates(),
    log,
  });
  return {
    agents: listedAgents,
    // With a mandate, only agents it can pay are asked: no quotes that could never be bought.
    quotes: async (skill, task, input) =>
      collectQuotes(skill, task, input, {
        ...(await base()),
        ...(config ? { mandateId: BigInt(config.mandateId) } : {}),
      }),
    fetchProfile: async (endpoint) => {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      return res?.ok
        ? ((await res.json().catch(() => null)) as { inputSchema?: unknown } | null)
        : null;
    },
    hire: config
      ? async (round, option, reason) => {
          const writer = arkivWriter(config.agentKey); // the buyer's job, rating and receipt
          const deps: HireDeps = {
            ...(await base()),
            buyerWriter: writer,
            platformWriter: writer,
            payingFetch: createPayingFetch({
              agent: privateKeyToAccount(config.agentKey),
              mandateId: BigInt(config.mandateId),
              payer: config.payer,
              executor: DEPLOYMENTS.testnet.mandateRegistryId,
              executorEvm: DEPLOYMENTS.testnet.mandateRegistry,
              chainId: hederaTestnet.id,
              resolver: new MirrorResolver(NETWORKS.testnet.mirrorUrl),
              maxAmount: BigInt(config.perPaymentCapUnits),
            }),
            mandateId: BigInt(config.mandateId),
            payer: config.payer,
          };
          return buy(round, option, "booked through the AgentNet MCP server", deps, reason);
        }
      : null,
    budget: config
      ? async () => ({
          remainingUnits: await mc.remaining(BigInt(config.mandateId)),
          expiresAt: config.expiresAt,
        })
      : null,
  };
}
