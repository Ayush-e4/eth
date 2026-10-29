import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * What the MCP server needs to pay agents: its own key (the mandate's `agent`, kept on this
 * machine), the mandate it may spend from, and the Hedera account that pays. Written by
 * `pnpm --filter @eth/mcp setup-mandate`; gitignored and readable only by you (mode 600).
 */
export const McpConfigSchema = z.object({
  agentKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as unknown as z.ZodType<`0x${string}`>,
  mandateId: z.string().regex(/^\d+$/),
  payer: z.string().regex(/^0\.0\.\d+$/),
  perPaymentCapUnits: z.string().regex(/^\d+$/),
  expiresAt: z.number().int(),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const CONFIG_PATH =
  process.env.AGENTNET_MCP_CONFIG ?? fileURLToPath(new URL("../.mcp.local.json", import.meta.url));

/** Null when there's no mandate yet: the market can still be browsed, nothing can be paid. */
export function loadConfig(path = CONFIG_PATH): McpConfig | null {
  try {
    return McpConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function saveConfig(config: McpConfig, path = CONFIG_PATH) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
