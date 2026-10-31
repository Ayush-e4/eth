import { limitCalls } from "@eth/mandates";
import { LimitCardSchema } from "@eth/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { MandateRow } from "../db/schema";
import type { DemoQuotaCheck } from "../demo/quotas";
import { type PasskeyWallets, WalletOpError } from "../wallet/service";
import type { HiringEnv } from "./env";
import {
  adoptPasskeyMandate,
  adoptUserMandate,
  chatRemaining,
  createDemoMandate,
  currentMandate,
  limitCardParams,
  MandateCheckError,
} from "./mandates";

const Body = z.union([
  z.object({ demo: z.literal(true), card: LimitCardSchema }),
  z.object({ mandateId: z.string().regex(/^\d{1,30}$/), card: LimitCardSchema }),
  // Face ID: the op prepared by POST /chats/:id/mandate/face-id, and the device's signature
  z.object({
    opId: z.uuid(),
    response: z.looseObject({ id: z.string().max(1024), response: z.looseObject({}) }),
    card: LimitCardSchema,
  }),
]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
export function mandateRoutes(
  db: Db,
  env: HiringEnv | null,
  demo: DemoQuotaCheck | null = null,
  /** A limit the server itself offered for one payment (e.g. PriceGuard's fee) also counts. */
  offered: (chatId: string, card: z.infer<typeof LimitCardSchema>) => boolean = () => false,
  wallets: PasskeyWallets | null = null,
) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/mandate", requireUser(db));
  app.use("/chats/:id/mandate/*", requireUser(db));

  // The card must be for what's left of this chat's limit (or one the server offered for a
  // single payment), and for this server's concierge.
  const stale = async (
    env: HiringEnv,
    chat: Parameters<typeof chatRemaining>[1],
    card: z.infer<typeof LimitCardSchema>,
  ) =>
    (card.budgetUnits !== (await chatRemaining(db, chat)).toString() && !offered(chat.id, card)) ||
    card.agent.toLowerCase() !== env.concierge.evm.toLowerCase() ||
    card.registry.toLowerCase() !== env.registry.toLowerCase() ||
    card.token.toLowerCase() !== env.usdc.toLowerCase();

  /** Face ID, step 1: what the user's device signs to set this limit from their own wallet. */
  app.post("/chats/:id/mandate/face-id", async (c) => {
    if (!env || !wallets) return c.json({ error: "Face ID wallets are off on this server" }, 503);
    const user = c.get("user");
    const chat = await store.get(user.id, c.req.param("id")).catch(() => null);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const body = z
      .object({ card: LimitCardSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send the limit card" }, 400);
    const { card } = body.data;
    if (await stale(env, chat, card))
      return c.json({ error: "this limit no longer matches the chat; ask again" }, 409);
    try {
      const calls = limitCalls(env.registry, limitCardParams(card));
      return c.json(
        await wallets.prepare(user.id, calls, { kind: "limit", chatId: chat.id, card }),
      );
    } catch (err) {
      if (err instanceof WalletOpError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.get("/chats/:id/mandate", async (c) => {
    const chat = await store.get(c.get("user").id, c.req.param("id")).catch(() => null);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const m = env ? await currentMandate(db, env, chat.id) : null;
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
    if (await stale(env, chat, card))
      return c.json({ error: "this limit no longer matches the chat; ask again" }, 409);
    try {
      if ("opId" in body.data) {
        if (!wallets) return c.json({ error: "Face ID wallets are off on this server" }, 503);
        const meta = wallets.meta(user.id, body.data.opId);
        if (meta?.kind !== "limit" || meta.chatId !== chat.id || !same(meta.card, card))
          return c.json({ error: "that approval is for something else; try again" }, 409);
        const run = await wallets.run(user.id, body.data.opId, body.data.response as never);
        const w = await wallets.get(user.id, false);
        if (run.mandateId === undefined || !w?.hederaId)
          return c.json({ error: "the limit didn't show up on Hedera; try again" }, 502);
        const m = await adoptPasskeyMandate(db, env, chat, card, {
          mandateId: run.mandateId,
          wallet: run.wallet,
          payer: w.hederaId,
        });
        return c.json({ mandate: mandateJson(m), tx: run.hash }, 201);
      }
      if ("demo" in body.data) {
        if (!user.isDemo) return c.json({ error: "approve the limit with your own wallet" }, 403);
        const over = await demo?.canCreateLimit(user.id);
        if (over) return c.json({ error: over }, 429);
        return c.json({ mandate: mandateJson(await createDemoMandate(db, env, chat, card)) }, 201);
      }
      const m = await adoptUserMandate(db, env, chat, user, BigInt(body.data.mandateId), card);
      return c.json({ mandate: mandateJson(m) }, 201);
    } catch (err) {
      if (err instanceof MandateCheckError || err instanceof WalletOpError)
        return c.json({ error: err.message }, 422);
      console.error("mandate failed", err);
      return c.json({ error: "couldn't set the limit on Hedera; try again" }, 502);
    }
  });

  return app;
}
