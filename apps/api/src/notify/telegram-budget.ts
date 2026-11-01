import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Db } from "../db/client";
import { chats } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { chatRemaining, currentMandate } from "../hiring/mandates";
import type { PasskeyWallets } from "../wallet/service";
import { telegramAppChat, telegramLink } from "./telegram-app-chat";

const DAYS = 7;
const Budget = z.object({ budgetUnits: z.enum(["100000", "300000", "1000000"]) });

/**
 * A Telegram budget: one limit, approved once with Face ID in the app, that the Telegram chat
 * spends from for 7 days, for any agent. Without it every hire in Telegram would need a trip to a
 * browser (where the person's passkey may not even be). The approval itself reuses the chat's
 * Face ID limit flow: this hands back the chat and the card to approve.
 */
export function telegramBudgetRoutes(
  db: Db,
  d: { env: HiringEnv | null; wallets: PasskeyWallets | null },
) {
  const app = new Hono<AuthEnv>();
  app.use("/notifications/telegram/budget", requireUser(db));

  app.get("/notifications/telegram/budget", async (c) => {
    const link = await telegramLink(db, { userId: c.get("user").id });
    const m = link?.appChatId && d.env ? await currentMandate(db, d.env, link.appChatId) : null;
    const remaining = m && d.env ? await d.env.mc.remaining(m.mandateId).catch(() => null) : null;
    return c.json({
      linked: !!link,
      budget:
        m && m.payees.length === 0
          ? {
              budgetUnits: m.budgetUnits.toString(),
              remainingUnits: remaining?.toString() ?? null,
              expiresAt: m.expiresAt.toISOString(),
            }
          : null,
    });
  });

  app.post("/notifications/telegram/budget", async (c) => {
    const { env, wallets } = d;
    if (!env || !wallets) return c.json({ error: "hiring is off on this server" }, 503);
    const user = c.get("user");
    const body = Budget.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "pick 0.10, 0.30 or 1.00 USDC" }, 400);
    const link = await telegramLink(db, { userId: user.id });
    if (!link) return c.json({ error: "connect Telegram first" }, 409);
    if ((await wallets.get(user.id, false))?.status !== "ready")
      return c.json({ error: "a Telegram budget needs a passkey account's wallet" }, 409);
    const chat = await telegramAppChat(db, user, link.appChatId ?? null);
    // The chat's limit becomes what it has spent plus the new budget, so the card is for exactly
    // the budget (the limit route checks the card against what's left).
    const budget = BigInt(body.data.budgetUnits);
    const spent = chat.limitUnits - (await chatRemaining(db, chat));
    await db
      .update(chats)
      .set({ limitUnits: spent + budget, mode: "auto" })
      .where(eq(chats.id, chat.id));
    const card: Extract<Card, { type: "limit" }> = {
      type: "limit",
      budgetUnits: budget.toString(),
      perPaymentCapUnits: (budget < 100_000n ? budget : 100_000n).toString(),
      expiresAt: Math.floor(Date.now() / 1000) + DAYS * 24 * 3600,
      registry: env.registry,
      token: env.usdc,
      agent: env.concierge.evm,
      payees: [], // any agent: the budget caps it, not a list
    };
    return c.json({ chatId: chat.id, card });
  });

  return app;
}
