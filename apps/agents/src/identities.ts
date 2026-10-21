import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Local agent identities created by `pnpm --filter @eth/agents identities`.
 * One ECDSA key per specialist does everything: it controls the agent's Hedera account
 * (where it gets paid), and it signs the agent's Arkiv records — so the marketplace author,
 * the mandate payee and the payment recipient are provably the same agent.
 * The file holds private keys: it is gitignored and written with mode 600.
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as unknown as z.ZodType<`0x${string}`>;
const evm = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as unknown as z.ZodType<`0x${string}`>;

const SpecialistIdentity = z.object({
  key: hex,
  evm,
  hederaAccount: z.string().regex(/^0\.0\.\d+$/),
});

/** The specialist agents this app runs, by slug. */
export const AGENT_SLUGS = ["skyhop", "airnest", "staywise"] as const;
export type AgentSlug = (typeof AGENT_SLUGS)[number];

export const IdentitiesSchema = z.object({
  orchestrator: z.object({ key: hex, evm }),
  agents: z.object({
    skyhop: SpecialistIdentity,
    airnest: SpecialistIdentity,
    staywise: SpecialistIdentity,
  }),
});

export type Identities = z.infer<typeof IdentitiesSchema>;
export type SpecialistIdentity = z.infer<typeof SpecialistIdentity>;

export const IDENTITIES_PATH = fileURLToPath(new URL("../.agents.local.json", import.meta.url));

export function loadIdentities(): Identities {
  let raw: string;
  try {
    raw = readFileSync(IDENTITIES_PATH, "utf8");
  } catch {
    throw new Error("No agent identities yet — run: pnpm --filter @eth/agents identities");
  }
  return IdentitiesSchema.parse(JSON.parse(raw));
}
