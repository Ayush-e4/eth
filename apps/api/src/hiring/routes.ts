import { LimitCardSchema } from "@eth/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { MandateRow } from "../db/schema";
import type { DemoQuotaCheck } from "../demo/quotas";
import type { HiringEnv } from "./env";
import {
  adoptUserMandate,
  chatRemaining,
  createDemoMandate,
  currentMandate,
  MandateCheckError,
} from "./mandates";

const Body = z.union([
  z.object({ demo: z.literal(true), card: LimitCardSchema }),
  z.object({ mandateId: z.string().regex(/^\d{1,30}$/), card: LimitCardSchema }),
]);

const mandateJson = (m: MandateRow, remaining?: bigint) => ({
  mandateId: m.mandateId.toString(),
  owner: m.owner,
  payer: m.payer,
  budgetUnits: m.budgetUnits.toString(),
  remainingUnits: remaining?.toString(),
  payees: m.payees,
  demo: m.demo,
  expiresAt: m.expiresAt.toISOString(),
});

/**
 * A chat's spending limit. Demo users approve with the shared test wallet; wallet users create
 * the mandate in MetaMask and hand us its id, which we check on-chain before using it.
 */
export function mandateRoutes(db: Db, env: HiringEnv | null, demo: DemoQuotaCheck | null = null) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/mandate", requireUser(db));

  app.get("/chats/:id/mandate", async (c) => {
    const chat = await store.get(c.get("user").id, c.req.param("id")).catch(() => null);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const m = await currentMandate(db, chat.id);
    if (!m || !env) return c.json({ mandate: null });
    const remaining = await env.mc.remaining(m.mandateId).catch(() => undefined);
    return c.json({ mandate: mandateJson(m, remaining) });
  });

  app.post("/chats/:id/mandate", async (c) => {
    if (!env) return c.json({ error: "hiring is not configured on this server" }, 503);
    const user = c.get("user");
    const chat = await store.get(user.id, c.req.param("id")).catch(() => null);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const body = Body.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: "send the limit card, and demo or a mandateId" }, 400);
    const { card } = body.data;
    // The card must be for what's left of this chat's limit, and for this server's concierge.
    if (
      card.budgetUnits !== (await chatRemaining(db, chat)).toString() ||
      card.agent.toLowerCase() !== env.concierge.evm.toLowerCase()
    ) {
      return c.json({ error: "this limit no longer matches the chat; ask again" }, 409);
    }
    try {
      if ("demo" in body.data) {
        if (!user.isDemo) return c.json({ error: "approve the limit with your own wallet" }, 403);
        const over = await demo?.canCreateLimit(user.id);
        if (over) return c.json({ error: over }, 429);
        return c.json({ mandate: mandateJson(await createDemoMandate(db, env, chat, card)) }, 201);
      }
      const m = await adoptUserMandate(db, env, chat, user, BigInt(body.data.mandateId), card);
      return c.json({ mandate: mandateJson(m) }, 201);
    } catch (err) {
      if (err instanceof MandateCheckError) return c.json({ error: err.message }, 422);
      console.error("mandate failed", err);
      return c.json({ error: "couldn't set the limit on Hedera; try again" }, 502);
    }
  });

  return app;
}
