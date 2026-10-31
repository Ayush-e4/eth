import { arkivReader, findAgents } from "@eth/arkiv";
import { Erc8004Client } from "@eth/mandates";
import { privateKeyToAccount } from "viem/accounts";
import type { HiringEnv } from "./env";

const IDS_MS = 60_000;

/**
 * After a paid job, the payer leaves a review on the agent's ERC-8004 identity: public, checkable
 * reputation that any app can read (only clients that paid count, and an agent can't review
 * itself). Best-effort: a missing identity or a failed write never touches the hire.
 */
export function reputation(env: HiringEnv, erc = new Erc8004Client(), reader = arkivReader()) {
  const rater = privateKeyToAccount(env.demo.key); // the wallet that pays agents for us
  let ids: { at: number; map: Promise<Map<string, bigint>> } | null = null;
  const idOf = async (agent: string) => {
    if (!ids || Date.now() - ids.at > IDS_MS)
      ids = {
        at: Date.now(),
        map: findAgents(reader).then(
          (all) =>
            new Map(
              all.flatMap((p) =>
                p.record.erc8004Id === undefined
                  ? []
                  : [[p.record.agent.toLowerCase(), p.record.erc8004Id] as const],
              ),
            ),
        ),
      };
    return (await ids.map).get(agent.toLowerCase());
  };

  return {
    /** A job was delivered and paid: score it 100 on the agent's identity. Never throws. */
    async rate(agent: string, skill: string, endpoint: string) {
      try {
        const id = await idOf(agent);
        if (id === undefined) return null;
        const receipt = await erc.giveFeedback(rater, id, 100, skill, endpoint);
        return receipt.transactionHash;
      } catch (err) {
        console.error("reputation: couldn't review", agent, String(err).slice(0, 200));
        return null;
      }
    },
  };
}

export type Reputation = ReturnType<typeof reputation>;
