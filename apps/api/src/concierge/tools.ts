import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { type Card, type ConciergeEvent, OptionsCardSchema } from "@eth/shared";
import { z } from "zod";
import type { Market } from "./market";

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
      "List agents on the open market that can do a kind of job, with what each charges. Skills include flights, hotels, priceguard (rebooks a hotel when its price drops), research. Leave skill out to see everything. The user sees the result as a card.",
    inputSchema: z.object({
      skill: z
        .string()
        .regex(/^[a-z0-9_.-]{1,64}$/)
        .optional()
        .describe("e.g. flights, hotels, research"),
    }),
    run: async ({ skill }) => {
      emit({ type: "status", label: "Looking at the market" });
      const agents = (await market.agents(skill)).slice(0, MAX_AGENTS);
      if (agents.length) show({ type: "agents", skill: skill ?? "all", agents });
      return JSON.stringify(
        agents.length
          ? agents.map((a) => ({
              name: a.name,
              skill: a.skill,
              title: a.title,
              feeUsdc: (Number(a.priceUnits) / 1e6).toFixed(2),
              description: a.description.slice(0, 300),
            }))
          : { none: `No agent on the market offers ${skill ?? "anything"} right now.` },
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
