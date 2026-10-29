import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Db } from "../db/client";
import { chats, hires, mandates } from "../db/schema";
import { type HiringEnv, hederaAccountOf } from "../hiring/env";

const fee = (units: bigint) => units.toString();

/** Balances from Hedera's public mirror node: USDC (6 decimals) and HBAR (tinybars). */
async function balances(mirrorUrl: string, account: string, usdcTokenId: string) {
  const res = await fetch(`${mirrorUrl}/api/v1/balances?account.id=${account}`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as {
    balances?: { balance: number; tokens: { token_id: string; balance: number }[] }[];
  };
  const b = body.balances?.[0];
  if (!b) return null;
  return {
    hbarTinybars: String(b.balance),
    usdcUnits: String(b.tokens.find((t) => t.token_id === usdcTokenId)?.balance ?? 0),
  };
}

/** What the signed-in user's agents did (Tasks) and what they spent through (Wallet). */
export function accountRoutes(db: Db, env: HiringEnv | null) {
  const app = new Hono<AuthEnv>();
  app.use("/tasks", requireUser(db));
  app.use("/wallet", requireUser(db));
  app.use("/wallet/*", requireUser(db));

  const hiresOf = (userId: string) =>
    db
      .select({ hire: hires, chatTitle: chats.title })
      .from(hires)
      .innerJoin(chats, eq(chats.id, hires.chatId))
      .where(eq(chats.userId, userId))
      .orderBy(desc(hires.createdAt))
      .limit(200);

  /** Every agent hired for you, newest first, with the proof. */
  app.get("/tasks", async (c) => {
    const rows = await hiresOf(c.get("user").id);
    return c.json({
      tasks: rows.map(({ hire: h, chatTitle }) => ({
        id: h.id,
        chatId: h.chatId,
        chatTitle,
        skill: h.skill,
        agent: h.agent,
        title: h.title.split(" — ")[0] ?? h.title,
        feeUnits: fee(h.feeUnits),
        mandateId: h.mandateId.toString(),
        hederaTx: h.hederaTx,
        jobKey: h.jobKey,
        result: h.result,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  });

  /** Your account, your limits as the chain sees them right now, and every fee paid. */
  app.get("/wallet", async (c) => {
    const user = c.get("user");
    const account = user.isDemo
      ? (env?.demo.account ?? null)
      : user.address && env
        ? await hederaAccountOf(env.mirrorUrl, user.address as `0x${string}`)
        : null;
    const rows = await db
      .select({ m: mandates, chatTitle: chats.title })
      .from(mandates)
      .innerJoin(chats, eq(chats.id, mandates.chatId))
      .where(eq(chats.userId, user.id))
      .orderBy(desc(mandates.createdAt))
      .limit(50);
    // Names for agents: saved with each limit; older limits fall back to who was paid.
    const paid = await hiresOf(user.id);
    const known = new Map(
      paid.map(({ hire }) => [hire.agent.toLowerCase(), hire.title.split(" — ")[0] ?? hire.title]),
    );
    const limits = await Promise.all(
      rows.map(async ({ m, chatTitle }) => {
        const onchain = env ? await env.mc.getMandate(m.mandateId).catch(() => null) : null;
        const expired =
          (onchain ? Number(onchain.expiresAt) * 1000 : m.expiresAt.getTime()) <= Date.now();
        return {
          mandateId: m.mandateId.toString(),
          chatId: m.chatId,
          chatTitle,
          demo: m.demo,
          budgetUnits: fee(onchain?.budget ?? m.budgetUnits),
          spentUnits: onchain ? fee(onchain.spent) : null,
          payees: m.payees.map(
            (p) =>
              m.payeeNames[p.toLowerCase()] ??
              known.get(p.toLowerCase()) ??
              `${p.slice(0, 6)}…${p.slice(-4)}`,
          ),
          expiresAt: m.expiresAt.toISOString(),
          status: onchain?.revoked ? "revoked" : expired ? "expired" : "active",
        };
      }),
    );
    return c.json({
      account,
      address: user.address,
      shared: user.isDemo, // demo users share one test wallet
      balances: account && env ? await balances(env.mirrorUrl, account, env.usdcTokenId) : null,
      spentUnits: fee(paid.reduce((s, { hire }) => s + hire.feeUnits, 0n)),
      limits,
      payments: paid.map(({ hire: h, chatTitle }) => ({
        id: h.id,
        chatTitle,
        to: h.title.split(" — ")[0] ?? h.title,
        skill: h.skill,
        feeUnits: fee(h.feeUnits),
        hederaTx: h.hederaTx,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  });

  /**
   * Cancel a demo limit (the demo wallet owns it, so the server signs). Wallet users own their
   * limits and cancel them in MetaMask; the chain is the record either way.
   */
  app.post("/wallet/limits/:mandateId/revoke", async (c) => {
    if (!env) return c.json({ error: "hiring is not configured on this server" }, 503);
    const id = c.req.param("mandateId");
    if (!/^\d{1,30}$/.test(id)) return c.json({ error: "no such limit" }, 404);
    // Someone else's limit is simply "not found".
    const [row] = await db
      .select({ m: mandates })
      .from(mandates)
      .innerJoin(chats, eq(chats.id, mandates.chatId))
      .where(and(eq(mandates.mandateId, BigInt(id)), eq(chats.userId, c.get("user").id)));
    if (!row) return c.json({ error: "no such limit" }, 404);
    if (!row.m.demo) return c.json({ error: "cancel this limit from your wallet" }, 409);
    await env.mc.revoke(privateKeyToAccount(env.demo.key), BigInt(id));
    return c.json({ ok: true });
  });

  return app;
}
