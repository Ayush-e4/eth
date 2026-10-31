import { buy, collectQuotes, fetchInrRates, type HireDeps } from "@eth/agents/hiring";
import { arkivReader, arkivWriter } from "@eth/arkiv";
import { createServer } from "@eth/mcp/server";
import type { HeldQuotes, ToolDeps } from "@eth/mcp/tools";
import { createPayingFetch, MirrorResolver } from "@eth/x402";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import type { Market } from "../concierge/market";
import type { Db } from "../db/client";
import type { HiringEnv } from "../hiring/env";
import { finishHire } from "../hiring/record";
import type { ChatPoster } from "../notify/post";
import type { Connection, OAuthStore } from "./oauth";

const usdc = (u: bigint) => `${(Number(u) / 1e6).toFixed(2)} USDC`;

/**
 * AgentNet as a remote MCP server (Streamable HTTP, a fresh server per request): a connected app
 * browses the market, gets quotes and hires, paying from the user's wallet under the limit the
 * user gave that app. Each hire is saved like any other and posted in the app's own chat (which
 * also nudges the user on Telegram), so nothing an app does is out of sight.
 */
export function mcpRoutes(
  db: Db,
  origin: string,
  d: {
    oauth: OAuthStore;
    env: HiringEnv | null;
    market: Market;
    post: ChatPoster | null;
    hidden?: (agent: string) => boolean;
  },
) {
  const app = new Hono();
  const held = new Map<string, HeldQuotes>(); // quotes waiting to be hired, per connection
  const heldFor = (id: string) => {
    const h = held.get(id) ?? new Map();
    held.set(id, h);
    return h;
  };

  const unauthorized = (c: Context) => {
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: "connect AgentNet first" }, 401);
  };

  function depsFor(env: HiringEnv, conn: Connection): ToolDeps {
    const mandateId = conn.mandateId ?? 0n;
    const base = async () => ({
      arkiv: arkivReader(),
      evm: env.mc.publicClient,
      registry: env.registry,
      inrRates: await fetchInrRates(),
      log: () => {},
    });
    return {
      agents: async (skill) =>
        (await d.market.agents(skill)).map((a) => ({
          name: a.name,
          skill: a.skill,
          title: a.title,
          description: a.description,
          feeUnits: BigInt(a.priceUnits),
          agent: a.agent,
          endpoint: a.endpoint,
        })),
      quotes: async (skill, task, input) => {
        const round = await collectQuotes(skill, task, input, { ...(await base()), mandateId });
        return { ...round, options: round.options.filter((o) => !d.hidden?.(o.agent)) };
      },
      fetchProfile: async (endpoint) => {
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        return res?.ok
          ? ((await res.json().catch(() => null)) as { inputSchema?: unknown } | null)
          : null;
      },
      hire: async (round, option, reason) => {
        if (conn.expiresAt.getTime() <= Date.now())
          throw new Error(
            "This app's spending limit has ended. Reconnect AgentNet to set a new one.",
          );
        const deps: HireDeps = {
          ...(await base()),
          buyerWriter: arkivWriter(env.concierge.key),
          platformWriter: arkivWriter(env.demo.key),
          payingFetch: createPayingFetch({
            agent: privateKeyToAccount(d.oauth.agentKey(conn.id)),
            mandateId,
            payer: conn.payer ?? "",
            executor: env.registryId,
            executorEvm: env.registry,
            chainId: env.mc.chain.id,
            resolver: new MirrorResolver(env.mirrorUrl),
            maxAmount: conn.perPaymentCapUnits,
          }),
          mandateId,
          payer: conn.payer ?? "",
        };
        const hire = await buy(
          round,
          option,
          `booked by ${conn.clientName} on AgentNet`,
          deps,
          reason,
        );
        if (conn.chatId) {
          const card = await finishHire(db, env, { chatId: conn.chatId, mandateId, hire });
          await d.post?.(
            conn.chatId,
            `${conn.clientName} hired ${card.title} for ${usdc(hire.feeUnits)}: ${card.summary}`,
            [card],
          );
        }
        return hire;
      },
      budget: async () => ({
        remainingUnits: await env.mc.remaining(mandateId),
        expiresAt: Math.floor(conn.expiresAt.getTime() / 1000),
      }),
    };
  }

  app.all("/mcp", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const conn = token ? await d.oauth.byAccessToken(token) : null;
    if (!conn || !d.env) return unauthorized(c);
    const server = createServer(depsFor(d.env, conn), heldFor(conn.id));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every request stands alone
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
