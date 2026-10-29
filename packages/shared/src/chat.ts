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

const units = z.string().regex(/^\d+$/); // USDC base units (6 decimals)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Live quotes for one job, best first. Tapping one sends its `reply`. */
export const QuotesCardSchema = z.object({
  type: z.literal("quotes"),
  skill: z.string(),
  reason: z.string(), // why the first one is the default pick
  quotes: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      note: z.string(),
      feeUnits: units,
      itemTotal: z.number().optional(),
      itemCurrency: z.string().optional(),
      totalInr: z.number().optional(), // item + fee in rupees, when comparable
      reply: z.string(),
    }),
  ),
});

/**
 * Before any agent is paid, the chat needs a spending limit on Hedera (a mandate): the most
 * the concierge may spend, and which agents it may pay. Everything needed to create it in
 * MetaMask is here; demo users approve it with the shared test wallet instead.
 */
export const LimitCardSchema = z.object({
  type: z.literal("limit"),
  budgetUnits: units,
  perPaymentCapUnits: units,
  expiresAt: z.number().int(), // unix seconds
  registry: address,
  token: address,
  agent: address, // the concierge, who signs each payment
  payees: z.array(z.object({ name: z.string(), agent: address })).min(1),
});

/** "Ask first" chats: the user approves one payment. The buttons send "Approve <code>" or "Decline <code>". */
export const ApprovalCardSchema = z.object({
  type: z.literal("approval"),
  code: z.string().regex(/^[a-z0-9]{6}$/),
  title: z.string(), // e.g. "Hire AirNest to book your flights"
  detail: z.string(),
  feeUnits: units,
});

/** An agent was paid and did the job. Links are proof anyone can check. */
export const HiredCardSchema = z.object({
  type: z.literal("hired"),
  skill: z.string(),
  title: z.string(),
  summary: z.string(),
  feeUnits: units,
  hederaTx: z.string(),
  jobKey: z.string(),
});

export const CardSchema = z.discriminatedUnion("type", [
  AgentsCardSchema,
  OptionsCardSchema,
  QuotesCardSchema,
  LimitCardSchema,
  ApprovalCardSchema,
  HiredCardSchema,
]);
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
