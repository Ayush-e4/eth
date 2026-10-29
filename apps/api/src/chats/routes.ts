import { ChatModeSchema, type ConciergeEvent, SendMessageSchema } from "@eth/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import type { Chat, Message } from "../db/schema";
import { chatStore } from "./store";

const MAX_LIMIT_UNITS = 5_000_000n; // a chat's limit can't exceed 5 USDC (the monthly default)

const PatchBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  mode: ChatModeSchema.optional(),
  limitUnits: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(BigInt)
    .refine((u) => u <= MAX_LIMIT_UNITS, "at most 5 USDC")
    .optional(),
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

export function chatRoutes(db: Db, concierge: Concierge | null) {
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
    c.json({ chat: chatJson(await store.create(c.get("user").id)) }, 201),
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

    const history = (await store.recent(chat.id)).map((m) => ({ role: m.role, text: m.text }));
    await store.add(chat, "user", body.data.text);

    return streamSSE(c, async (sse) => {
      const send = (e: ConciergeEvent) => sse.writeSSE({ event: e.type, data: JSON.stringify(e) });
      const abort = new AbortController();
      sse.onAbort(() => abort.abort());
      try {
        const reply = await concierge({
          history,
          text: body.data.text,
          user: { displayName: user.displayName, homeCity: user.homeCity },
          chat: { mode: chat.mode, limitUnits: chat.limitUnits },
          emit: (e) => void send(e),
          signal: abort.signal,
        });
        const saved = await store.add(chat, "assistant", reply.text, reply.cards);
        await send({ type: "done", messageId: saved.id });
      } catch (err) {
        console.error("concierge failed", err);
        if (!abort.signal.aborted) {
          await send({ type: "error", message: "The concierge couldn't answer. Try again." });
        }
      }
    });
  });

  return app;
}
