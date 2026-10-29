import { z } from "zod";

/**
 * What the concierge sends the web app while it answers. Text arrives as deltas; cards are
 * structured blocks the app draws (agent options, choices to tap) instead of parsing prose.
 */

/** Agents from the open market that can do something the user asked for. */
export const AgentsCardSchema = z.object({
  type: z.literal("agents"),
  skill: z.string(),
  agents: z.array(
    z.object({
      name: z.string(),
      skill: z.string(),
      title: z.string(), // the listing's one-line pitch
      description: z.string(),
      priceUnits: z.string(), // agent fee per job, USDC base units
      agent: z.string(), // EVM address that signs its Arkiv records
      endpoint: z.string(),
    }),
  ),
});

/** Claude-style choices: tapping one sends its `reply` as the user's next message. */
export const OptionsCardSchema = z.object({
  type: z.literal("options"),
  question: z.string(),
  options: z
    .array(z.object({ label: z.string(), detail: z.string().optional(), reply: z.string() }))
    .min(2)
    .max(5),
});

export const CardSchema = z.discriminatedUnion("type", [AgentsCardSchema, OptionsCardSchema]);
export type Card = z.infer<typeof CardSchema>;

export const ConciergeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("card"), card: CardSchema }),
  z.object({ type: z.literal("status"), label: z.string() }), // e.g. "Looking at the market"
  z.object({ type: z.literal("done"), messageId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ConciergeEvent = z.infer<typeof ConciergeEventSchema>;

/** How a chat spends: on its own up to a limit, or asking every time. */
export const ChatModeSchema = z.enum(["auto", "ask"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const SendMessageSchema = z.object({ text: z.string().trim().min(1).max(4000) });
