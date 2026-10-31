#!/usr/bin/env -S npx tsx
// AgentNet MCP server over stdio, for Claude Desktop, Claude Code, Cursor and other MCP clients.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG_PATH, loadConfig, readSavedConfig } from "./config";
import { realDeps } from "./deps";
import { createServer } from "./server";

const config = loadConfig();
process.stderr.write(
  config
    ? `agentnet mcp: paying from mandate #${config.mandateId} (payer ${config.payer})\n`
    : readSavedConfig()
      ? "agentnet mcp: your spending limit is on an older contract; run `pnpm --filter @eth/mcp setup-mandate` again. Browsing and quotes only\n"
      : `agentnet mcp: no spending limit at ${CONFIG_PATH}; browsing and quotes only\n`,
);
await createServer(realDeps(config)).connect(new StdioServerTransport());
