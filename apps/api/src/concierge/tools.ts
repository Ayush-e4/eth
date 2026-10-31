import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { hasJobFee } from "@eth/arkiv";
import { type Card, type ConciergeEvent, OptionsCardSchema } from "@eth/shared";
import { z } from "zod";
import type { Market } from "./market";
import { matchAgents } from "./match";

const MAX_AGENTS = 6; // per card, so one search can't flood the chat

/** The concierge's tools. They only read the market and show cards; none of them moves money. */
export function conciergeTools(
  market: Market,
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
) {
  const findAgents = betaZodTool({
    name: "find_agents",
    description:
      "List agents on the open market that can do a job, with what each charges. Pass `skill` when you know it (see the market list in your instructions), or `need` in the user's words to match agents by what they say they do. Leave both out to see everything. The user sees the result as a card.",
    inputSchema: z.object({
      skill: z
        .string()
        .regex(/^[a-z0-9_.-]{1,64}$/)
        .optional()
        .describe("e.g. flights, hotels"),
      need: z.string().max(200).optional().describe("what the user needs, in their words"),
    }),
    run: async ({ skill, need }) => {
      emit({ type: "status", label: "Looking at the market" });
      const all = await market.agents(skill);
      const agents = (need && !skill ? matchAgents(all, need) : all).slice(0, MAX_AGENTS);
      if (agents.length) show({ type: "agents", skill: skill ?? "all", agents });
      return JSON.stringify(
        agents.length
          ? agents.map((a) => ({
              name: a.name,
              skill: a.skill,
              title: a.title,
              feeUsdc: hasJobFee(a.priceUnits)
                ? (Number(a.priceUnits) / 1e6).toFixed(2)
                : "none per job (see description)",
              description: a.description.slice(0, 300),
              identity: a.identity
                ? `ERC-8004 #${a.identity.erc8004Id} on Hedera; ${a.identity.paidJobs} paid jobs reviewed, average ${a.identity.averageScore ?? "n/a"}/100`
                : "no on-chain identity",
            }))
          : {
              none: `No agent on the market ${need ? `matches "${need}"` : `offers ${skill ?? "anything"}`} right now.`,
            },
      );
    },
  });

  const showOptions = betaZodTool({
    name: "show_options",
    description:
      "Show the user 2 to 5 tappable choices. Tapping one sends its reply text as the user's next message. Use it whenever the user has to pick.",
    inputSchema: OptionsCardSchema.omit({ type: true }),
    run: async (input) => {
      show({ type: "options", ...input });
      return "Shown to the user. Wait for their pick.";
    },
  });

  return { findAgents, showOptions };
}
