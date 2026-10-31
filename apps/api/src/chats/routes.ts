import { ChatModeSchema, type ConciergeEvent, SendMessageSchema } from "@eth/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import { type Chat, hires, type Message } from "../db/schema";
import { limitUnitsSchema } from "../limits";
import { withCardNotes } from "./card-notes";
import { chatStore } from "./store";

const PatchBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  mode: ChatModeSchema.optional(),
  limitUnits: limitUnitsSchema.optional(),
});

const chatJson = (c: Chat) => ({
  id: c.id,
  title: c.title,
  mode: c.mode,
  limitUnits: c.limitUnits.toString(),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const messageJson = (m: Message) => ({
  id: m.id,
  role: m.role,
  text: m.text,
  cards: m.cards,
  createdAt: m.createdAt.toISOString(),
});

const isUuid = (s: string) => z.uuid().safeParse(s).success;

export function chatRoutes(
  db: Db,
  concierge: Concierge | null,
  onUserMessage: (chatId: string, text: string) => unknown = () => {},
) {
  const hiredIn = (chatId: string) =>
    db.select().from(hires).where(eq(hires.chatId, chatId)).orderBy(asc(hires.createdAt));
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats", requireUser(db));
  app.use("/chats/*", requireUser(db));

  const owned = async (userId: string, id: string) =>
    isUuid(id) ? store.get(userId, id) : Promise.resolve(null);

  app.get("/chats", async (c) =>
    c.json({ chats: (await store.list(c.get("user").id)).map(chatJson) }),
  );

  app.post("/chats", async (c) =>
    c.json({ chat: chatJson(await store.create(c.get("user"))) }, 201),
  );

  app.get("/chats/:id", async (c) => {
    const chat = await owned(c.get("user").id, c.req.param("id"));
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const msgs = await store.messages(chat.id);
    return c.json({ chat: chatJson(chat), messages: msgs.map(messageJson) });
  });

  app.patch("/chats/:id", async (c) => {
    const body = PatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid settings", issues: body.error.issues }, 400);
    const chat = await store.update(c.get("user").id, c.req.param("id"), body.data);
    return chat ? c.json({ chat: chatJson(chat) }) : c.json({ error: "chat not found" }, 404);
  });

  app.delete("/chats/:id", async (c) => {
    const id = c.req.param("id");
    const gone = isUuid(id) && (await store.remove(c.get("user").id, id));
    return gone ? c.json({ ok: true }) : c.json({ error: "chat not found" }, 404);
  });

  /**
   * Send a message; the reply streams back as Server-Sent Events (text deltas, cards, status,
   * then done or error). The user's message is saved first, the reply once it's complete.
   */
  app.post("/chats/:id/messages", async (c) => {
    const user = c.get("user");
    const chat = await owned(user.id, c.req.param("id"));
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const body = SendMessageSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send text (1 to 4000 characters)" }, 400);
    if (!concierge) return c.json({ error: "the concierge is not configured" }, 503);

    const history = (await store.recent(chat.id)).map((m) => ({
      role: m.role,
      text: withCardNotes(m.text, m.cards),
    }));
    await store.add(chat, "user", body.data.text);
    await onUserMessage(chat.id, body.data.text); // e.g. "Approve abc123"

    const hired = (await hiredIn(chat.id)).map(
      (h) =>
        `${h.title.split(" — ")[0]} did the ${h.skill} job, paid ${(Number(h.feeUnits) / 1e6).toFixed(2)} USDC (tx ${h.hederaTx}); result: ${JSON.stringify(h.result ?? null).slice(0, 600)}`,
    );

    const res = streamSSE(c, async (sse) => {
      // The browser may go away mid-turn. We keep going anyway: an agent may already have been
      // paid, so the turn must finish and be saved. We just stop writing to a closed stream.
      let open = true;
      sse.onAbort(() => {
        open = false;
      });
      const send = (e: ConciergeEvent) =>
        open ? sse.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {}) : undefined;
      // Hiring can take a minute; a ping every 10 s stops proxies closing a quiet stream.
      const ping = setInterval(() => {
        if (open) void sse.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, 10_000);
      try {
        const reply = await concierge({
          history,
          hired,
          text: body.data.text,
          user: { displayName: user.displayName, homeCity: user.homeCity },
          chat: { id: chat.id, mode: chat.mode, limitUnits: chat.limitUnits },
          emit: (e) => void send(e),
        });
        const saved = await store.add(chat, "assistant", reply.text, reply.cards);
        await send({ type: "done", messageId: saved.id });
      } catch (err) {
        console.error("concierge failed", err);
        await send({ type: "error", message: "The concierge couldn't answer. Try again." });
      } finally {
        clearInterval(ping);
      }
    });
    // no-transform: a proxy (Next's /api rewrite) must not gzip, and so hold back, live events.
    // (Set after streamSSE, which sets its own; Hono copies these onto the response.)
    c.header("Cache-Control", "no-cache, no-transform");
    return res;
  });

  return app;
}
