import { limitCalls } from "@eth/mandates";
import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { chats } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { adoptPasskeyMandate, limitCardParams } from "../hiring/mandates";
import { type PasskeyWallets, WalletOpError } from "../wallet/service";
import { type OAuthStore, okRedirect } from "./oauth";

const DAYS = 7; // how long a connected app's limit lasts
const BUDGETS = ["100000", "300000", "1000000"] as const; // 0.10, 0.30, 1.00 USDC
const Authorize = z.object({
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().max(500),
  state: z.string().max(500).optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  budgetUnits: z.enum(BUDGETS),
});
const Approve = z.object({
  opId: z.uuid(),
  response: z.looseObject({ id: z.string().max(1024), response: z.looseObject({}) }),
});

const withParams = (uri: string, params: Record<string, string | undefined>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * OAuth for connected apps (see oauth.ts), and the consent step: the consent page posts here,
 * Face ID sets the app's limit from the user's own wallet, and the app gets its code.
 */
export function connectRoutes(
  db: Db,
  config: Config,
  d: { oauth: OAuthStore; env: HiringEnv | null; wallets: PasskeyWallets | null },
) {
  const app = new Hono<AuthEnv>();
  const origin = config.appOrigin;
  const pending = new Map<string, z.infer<typeof Authorize> & { connectionId: string }>();

  app.get("/oauth/metadata", (c) =>
    c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/connect/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["agents"],
    }),
  );
  app.get("/oauth/resource", (c) =>
    c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "AgentNet",
    }),
  );

  // Dynamic client registration: any app may register; what it can do is decided per user.
  app.post("/oauth/register", async (c) => {
    const body = z
      .object({
        client_name: z.string().max(100).optional(),
        redirect_uris: z.array(z.string().max(500)).min(1).max(5),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success || !body.data.redirect_uris.every(okRedirect))
      return c.json({ error: "invalid_redirect_uri" }, 400);
    const cl = await d.oauth.register(body.data.client_name || "An app", body.data.redirect_uris);
    return c.json(
      {
        client_id: cl.id,
        client_name: cl.name,
        redirect_uris: cl.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  app.post("/oauth/token", async (c) => {
    const type = c.req.header("content-type") ?? "";
    const raw = type.includes("json")
      ? await c.req.json().catch(() => ({}))
      : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const p = raw as Record<string, string | undefined>;
    const tokens =
      p.grant_type === "authorization_code" && p.code && p.client_id && p.code_verifier
        ? await d.oauth.exchange(p.code, p.client_id, p.redirect_uri ?? "", p.code_verifier)
        : p.grant_type === "refresh_token" && p.refresh_token && p.client_id
          ? await d.oauth.refresh(p.refresh_token, p.client_id)
          : null;
    if (!tokens) return c.json({ error: "invalid_grant" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(tokens);
  });

  /** For the consent page: who's asking (public). */
  app.get("/oauth/clients/:id", async (c) => {
    const cl = await d.oauth.client(c.req.param("id"));
    return cl ? c.json({ name: cl.name }) : c.json({ error: "unknown app" }, 404);
  });

  app.use("/oauth/authorize", requireUser(db));
  app.use("/oauth/authorize/*", requireUser(db));
  app.use("/connections", requireUser(db));
  app.use("/connections/*", requireUser(db));

  /** Step 1: what the user's device signs to give this app a limit of its own. */
  app.post("/oauth/authorize", async (c) => {
    const { env, wallets } = d;
    if (!env || !wallets) return c.json({ error: "connected apps are off here" }, 503);
    const body = Authorize.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const cl = await d.oauth.client(body.data.client_id);
    if (!cl?.redirectUris.includes(body.data.redirect_uri))
      return c.json({ error: "unknown app or address" }, 400);
    const user = c.get("user");
    const budget = BigInt(body.data.budgetUnits);
    const cap = budget < 100_000n ? budget : 100_000n;
    const expiresAt = new Date(Date.now() + DAYS * 24 * 3600 * 1000);
    const conn = await d.oauth.start({
      userId: user.id,
      clientId: cl.id,
      clientName: cl.name,
      budgetUnits: budget,
      perPaymentCapUnits: cap,
      expiresAt,
    });
    try {
      const calls = limitCalls(env.registry, {
        ...limitCardParams(cardFor(env, conn.agentAddress, budget, cap, expiresAt)),
        payees: [], // any agent on the market, within the budget
      });
      const op = await wallets.prepare(user.id, calls, { kind: "connect", connectionId: conn.id });
      pending.set(op.opId, { ...body.data, connectionId: conn.id });
      return c.json(op);
    } catch (err) {
      if (err instanceof WalletOpError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  /** Step 2: the signature came back. Set the limit, open the app's chat, hand back a code. */
  app.post("/oauth/authorize/approve", async (c) => {
    const { env, wallets } = d;
    if (!env || !wallets) return c.json({ error: "connected apps are off here" }, 503);
    const body = Approve.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const user = c.get("user");
    const req = pending.get(body.data.opId);
    const meta = wallets.meta(user.id, body.data.opId);
    if (!req || meta?.kind !== "connect" || meta.connectionId !== req.connectionId)
      return c.json({ error: "that approval expired; start again from the app" }, 409);
    pending.delete(body.data.opId);
    const conn = await d.oauth.connection(req.connectionId);
    const w = await wallets.get(user.id, false);
    if (!conn || !w?.hederaId) return c.json({ error: "your wallet isn't ready" }, 409);
    try {
      const run = await wallets.run(user.id, body.data.opId, body.data.response as never);
      if (run.mandateId === undefined)
        return c.json({ error: "the limit didn't show up on Hedera; try again" }, 502);
      const chat = await chatStore(db).create({
        id: user.id,
        defaultMode: "auto",
        defaultLimitUnits: conn.budgetUnits,
      });
      await db
        .update(chats)
        .set({ title: `${conn.clientName} (connected app)` })
        .where(eq(chats.id, chat.id));
      const card = cardFor(
        env,
        conn.agentAddress,
        conn.budgetUnits,
        conn.perPaymentCapUnits,
        conn.expiresAt,
      );
      await adoptPasskeyMandate(db, env, chat, card, {
        mandateId: run.mandateId,
        wallet: run.wallet,
        payer: w.hederaId,
      });
      await d.oauth.activate(conn.id, {
        mandateId: run.mandateId,
        payer: w.hederaId,
        chatId: chat.id,
      });
      const code = await d.oauth.code(conn.id, req.client_id, req.redirect_uri, req.code_challenge);
      return c.json({ redirect: withParams(req.redirect_uri, { code, state: req.state }) });
    } catch (err) {
      if (err instanceof WalletOpError) return c.json({ error: err.message }, 422);
      throw err;
    }
  });

  app.get("/connections", async (c) => {
    const rows = await d.oauth.forUser(c.get("user").id);
    return c.json({
      connections: rows
        .filter((r) => r.status === "active")
        .map((r) => ({
          id: r.id,
          app: r.clientName,
          chatId: r.chatId,
          budgetUnits: r.budgetUnits.toString(),
          expiresAt: r.expiresAt.toISOString(),
          lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        })),
    });
  });

  app.delete("/connections/:id", async (c) =>
    (await d.oauth.revoke(c.get("user").id, c.req.param("id")))
      ? c.json({ ok: true })
      : c.json({ error: "no such connection" }, 404),
  );

  return app;
}

/** The limit a connected app gets: any agent, within its budget, from the user's own wallet. */
function cardFor(
  env: HiringEnv,
  agent: string,
  budget: bigint,
  cap: bigint,
  expiresAt = new Date(Date.now() + DAYS * 24 * 3600 * 1000),
): Extract<Card, { type: "limit" }> {
  return {
    type: "limit",
    budgetUnits: budget.toString(),
    perPaymentCapUnits: cap.toString(),
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    registry: env.registry,
    token: env.usdc,
    agent,
    payees: [],
  };
}
