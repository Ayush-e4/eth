import type {
  BetaMCPToolset,
  BetaRequestMCPServerURLDefinition,
} from "@anthropic-ai/sdk/resources/beta/messages";

/**
 * LiteAPI's MCP server, connected by Anthropic during the request (MCP connector beta).
 * Allowlist mode: Claude may only *read* — hotel search by meaning, Q&A about a hotel, reviews,
 * details. Booking tools stay off, so nothing gets booked except through a paid agent.
 */
export const LITEAPI_READ_ONLY = [
  "get_data_hotels_semantic_search",
  "get_data_hotel_ask",
  "get_data_reviews",
  "get_data_hotel",
] as const;

export const MCP_BETA = "mcp-client-2025-11-20";

export function liteApiResearch(sandboxKey: string): {
  server: BetaRequestMCPServerURLDefinition;
  toolset: BetaMCPToolset;
} {
  // The key travels inside the URL (LiteAPI's only option); never a production key.
  if (!sandboxKey.startsWith("sand_")) throw new Error("LiteAPI research needs a sandbox key");
  return {
    server: {
      type: "url",
      name: "liteapi",
      url: `https://mcp.liteapi.travel/api/mcp?apiKey=${sandboxKey}`,
    },
    toolset: {
      type: "mcp_toolset",
      mcp_server_name: "liteapi",
      default_config: { enabled: false },
      configs: Object.fromEntries(LITEAPI_READ_ONLY.map((name) => [name, { enabled: true }])),
    },
  };
}
