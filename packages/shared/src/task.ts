import { z } from "zod";

/**
 * The one request format every agent on the market speaks, whatever it does (flights,
 * hotels, research, deals, food). The envelope is the same; `input` is skill-specific and
 * each agent publishes the JSON Schema it accepts on its profile (GET /), so a buyer — or
 * the concierge — can learn how to call an agent it has never seen before.
 */

export const TaskIdSchema = z.string().regex(/^[a-z0-9_.-]{1,64}$/, "task id: a-z 0-9 _ . -");
export const SkillSchema = z.string().regex(/^[a-z0-9_.-]{1,64}$/, "skill: a-z 0-9 _ . -");

/** Body of POST /quote and POST /work. `quoteKey` is required for /work. */
export const TaskRequestSchema = z.object({
  task: TaskIdSchema,
  skill: SkillSchema,
  input: z.unknown(),
  quoteKey: z.string().max(80).optional(),
});

export interface TaskRequest<Input = unknown> {
  task: string;
  skill: string;
  input: Input;
  quoteKey?: string;
}

/** Reply to POST /quote. Prices are also signed on Arkiv; buyers trust those, not this reply. */
export const QuoteReplySchema = z.object({
  quoteKey: z.string(),
  priceUnits: z.string(), // agent fee, USDC base units
  note: z.string(),
  itemTotal: z.number().optional(), // what the item itself costs (ticket, room), if anything
  itemCurrency: z.string().optional(),
});

export type QuoteReply = z.infer<typeof QuoteReplySchema>;

/** GET / on every agent. */
export const AgentProfileSchema = z.object({
  name: z.string(),
  skill: SkillSchema,
  agent: z.string(), // EVM address that signs its Arkiv records
  price: z.string(), // agent fee per job, USDC base units
  inputSchema: z.record(z.string(), z.unknown()), // JSON Schema of `input`
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Error replies every agent uses, so buyers can react without parsing prose. */
export const TASK_ERRORS = {
  invalidBody: "invalid_body",
  wrongSkill: "wrong_skill",
  invalidInput: "invalid_input",
  unknownQuote: "unknown_or_expired_quote",
  workFailed: "work_failed",
} as const;
