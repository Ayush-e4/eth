import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { EscrowReviews } from "./review";
import type { UndoWindows } from "./undo";

const ESCROW_ID = /^0x[0-9a-f]{64}$/i;

/**
 * A chat's payments, owner only: those in their undo window (status, cancel), and fees held
 * on delivery for the user's review (status, pay now, dispute).
 */
export function paymentRoutes(db: Db, undo: UndoWindows | null, review: EscrowReviews | null) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/payments/*", requireUser(db));
  app.use("/chats/:id/escrows/*", requireUser(db));

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

  /** The chat's own held fee, or null: someone else's is simply "not found". */
  const heldFee = async (c: Parameters<typeof chatOf>[0], id: string, escrowId: string) => {
    if (!review || !ESCROW_ID.test(escrowId)) return null;
    const chat = await chatOf(c, id);
    return chat && (await review.status(chat.id, escrowId)) ? chat : null;
  };

  app.get("/chats/:id/escrows/:escrowId", async (c) => {
    const chat = await chatOf(c, c.req.param("id"));
    const s = chat && review ? await review.status(chat.id, c.req.param("escrowId")) : null;
    return s ? c.json({ escrow: s }) : c.json({ error: "no such payment in this chat" }, 404);
  });

  for (const move of ["release", "dispute"] as const)
    app.post(`/chats/:id/escrows/:escrowId/${move}`, async (c) => {
      const escrowId = c.req.param("escrowId");
      if (!(await heldFee(c, c.req.param("id"), escrowId)))
        return c.json({ error: "no such payment in this chat" }, 404);
      const out = await (review as EscrowReviews)[move](escrowId);
      return out.ok ? c.json({ ok: true }) : c.json({ error: out.reason }, 409);
    });

  return app;
}
