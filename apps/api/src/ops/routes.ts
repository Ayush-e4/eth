import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { balances } from "../account/balances";
import { rolesFor } from "../auth/roles";
import type { AuthEnv } from "../auth/routes";
import { SESSION_COOKIE, userForToken } from "../auth/session";
import type { Market } from "../concierge/market";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { chats, hires, messages, passkeys, passkeyWallets, users } from "../db/schema";
import { type HiringEnv, hederaAccountOf } from "../hiring/env";
import type { MarketCatalog } from "../market/catalog";
import type { StatusCheck } from "../status/check";
import type { HiddenAgents } from "./hidden";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const Hide = z.object({ reason: z.string().trim().min(3).max(200) });

export interface OpsDeps {
  env: HiringEnv | null;
  status: StatusCheck | null;
  /** Every listed agent, hidden ones too (the catalog over the unfiltered market). */
  allAgents: MarketCatalog | null;
  market: Market | null;
  hidden: HiddenAgents;
  giftsPerDay: number;
}

/**
 * The ops page, for admins only: is the money there, is anyone using it, are the agents up,
 * and a switch to hide an agent that misbehaves. Everything else stays public (/status, /log).
 */
export function opsRoutes(db: Db, config: Config, d: OpsDeps) {
  const app = new Hono<AuthEnv>();
  const admin = createMiddleware<AuthEnv>(async (c, next) => {
    const user = await userForToken(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: "sign in first" }, 401);
    if (!rolesFor(user, config.admins, config.adminUsers).includes("admin"))
      return c.json({ error: "admins only", yourAccountId: user.id }, 403);
    c.set("user", user);
    await next();
  });
  app.use("/ops", admin);
  app.use("/ops/*", admin);

  app.get("/ops", async (c) => {
    const day = new Date(Date.now() - 24 * 3600 * 1000);
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const conciergeAccount = d.env
      ? await hederaAccountOf(d.env.mirrorUrl, d.env.concierge.evm).catch(() => null)
      : null;
    const [status, agents, hidden, recent] = await Promise.all([
      d.status?.get().catch(() => null),
      d.allAgents?.list().catch(() => null),
      d.hidden.list(),
      db
        .select({ hire: hires, chatTitle: chats.title })
        .from(hires)
        .innerJoin(chats, eq(chats.id, hires.chatId))
        .orderBy(desc(hires.createdAt))
        .limit(20),
    ]);
    const people = {
      users: await n(db.select({ n: count() }).from(users)),
      passkey: await n(db.select({ n: count() }).from(passkeys)),
      wallet: await n(db.select({ n: count() }).from(users).where(isNotNull(users.address))),
      faceIdWallets: await n(db.select({ n: count() }).from(passkeyWallets)),
      newToday: await n(db.select({ n: count() }).from(users).where(gte(users.createdAt, day))),
      messagesToday: await n(
        db.select({ n: count() }).from(messages).where(gte(messages.createdAt, day)),
      ),
      hiresToday: await n(db.select({ n: count() }).from(hires).where(gte(hires.createdAt, day))),
      giftsToday: await n(
        db
          .select({ n: count() })
          .from(passkeyWallets)
          .where(and(isNotNull(passkeyWallets.giftUnits), gte(passkeyWallets.createdAt, day))),
      ),
      giftsPerDay: d.giftsPerDay,
    };
    return c.json({
      money: {
        demoWallet: status?.wallet ?? null,
        demoFees: status?.demo ?? null,
        concierge:
          conciergeAccount && d.env
            ? {
                account: conciergeAccount,
                ...(await balances(d.env.mirrorUrl, conciergeAccount, d.env.usdcTokenId)),
              }
            : null,
      },
      people,
      services: status?.services ?? [],
      networks: status?.networks ?? [],
      agents: (agents?.agents ?? []).map((a) => {
        const h = hidden.find((x) => x.agent === a.agent.toLowerCase());
        return {
          name: a.name,
          skill: a.skill,
          agent: a.agent,
          priceUnits: a.priceUnits,
          up: a.up,
          jobsHere: a.jobsHere,
          earnedHereUnits: a.earnedHereUnits,
          lastJobAt: a.lastJobAt,
          hidden: h ? { reason: h.reason, at: h.createdAt.toISOString() } : null,
        };
      }),
      recentHires: recent.map(({ hire: h, chatTitle }) => ({
        at: h.createdAt.toISOString(),
        agent: h.title.split(" — ")[0] ?? h.title,
        skill: h.skill,
        feeUnits: h.feeUnits.toString(),
        chatTitle,
        hederaTx: h.hederaTx,
      })),
    });
  });

  app.post("/ops/agents/:address/hide", async (c) => {
    const address = c.req.param("address");
    const body = Hide.safeParse(await c.req.json().catch(() => null));
    if (!ADDRESS.test(address) || !body.success)
      return c.json({ error: "say why (3–200 characters)" }, 400);
    const listed = (await d.market?.agents().catch(() => []))?.find(
      (a) => a.agent.toLowerCase() === address.toLowerCase(),
    );
    await d.hidden.hide(address, listed?.name ?? address, body.data.reason, c.get("user").id);
    return c.json({ ok: true });
  });

  app.post("/ops/agents/:address/unhide", async (c) => {
    const address = c.req.param("address");
    if (!ADDRESS.test(address)) return c.json({ error: "not an address" }, 400);
    await d.hidden.unhide(address);
    return c.json({ ok: true });
  });

  return app;
}
