import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { UndoWindows } from "./undo";

/** A chat's payments in their undo window: how they stand, and cancelling one (owner only). */
export function paymentRoutes(db: Db, undo: UndoWindows | null) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/payments/*", requireUser(db));

  const chatOf = (c: { get(k: "user"): { id: string } }, id: string) =>
    store.get(c.get("user").id, id).catch(() => null);

  app.get("/chats/:id/payments/:scheduleId", async (c) => {
    if (!undo) return c.json({ error: "undo windows are off on this server" }, 503);
    const chat = await chatOf(c, c.req.param("id"));
    const s = chat ? await undo.status(chat.id, c.req.param("scheduleId")) : null;
    return s ? c.json({ payment: s }) : c.json({ error: "no such payment in this chat" }, 404);
  });

  app.post("/chats/:id/payments/:scheduleId/cancel", async (c) => {
    if (!undo) return c.json({ error: "undo windows are off on this server" }, 503);
    const chat = await chatOf(c, c.req.param("id"));
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const out = await undo.cancel(chat.id, c.req.param("scheduleId"));
    return out.ok ? c.json({ ok: true }) : c.json({ error: out.reason ?? "couldn't cancel" }, 409);
  });

  return app;
}
