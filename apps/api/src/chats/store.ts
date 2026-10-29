import type { Card, ChatMode } from "@eth/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Chat, chats, type Message, messages } from "../db/schema";

/** How many earlier turns the concierge sees; older ones stay in the database. */
export const HISTORY_TURNS = 30;

const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
};

/** Every query is scoped to the owner: someone else's chat id simply isn't found. */
export function chatStore(db: Db) {
  return {
    async create(userId: string, firstText?: string): Promise<Chat> {
      const [chat] = await db
        .insert(chats)
        .values({ userId, title: firstText ? titleFrom(firstText) : "New chat" })
        .returning();
      if (!chat) throw new Error("could not create the chat");
      return chat;
    },

    list(userId: string): Promise<Chat[]> {
      return db
        .select()
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt))
        .limit(100);
    },

    async get(userId: string, chatId: string): Promise<Chat | null> {
      const [chat] = await db
        .select()
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      return chat ?? null;
    },

    messages(chatId: string): Promise<Message[]> {
      return db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.createdAt));
    },

    /** The latest turns, oldest first, for the concierge's context. */
    async recent(chatId: string): Promise<Message[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.createdAt))
        .limit(HISTORY_TURNS);
      return rows.reverse();
    },

    async add(chat: Chat, role: Message["role"], text: string, cards: Card[] = []) {
      const [msg] = await db
        .insert(messages)
        .values({ chatId: chat.id, role, text, cards })
        .returning();
      if (!msg) throw new Error("could not save the message");
      const firstMessage = role === "user" && chat.title === "New chat";
      await db
        .update(chats)
        .set({ updatedAt: new Date(), ...(firstMessage ? { title: titleFrom(text) } : {}) })
        .where(eq(chats.id, chat.id));
      return msg;
    },

    async update(
      userId: string,
      chatId: string,
      patch: { title?: string; mode?: ChatMode; limitUnits?: bigint },
    ): Promise<Chat | null> {
      const [chat] = await db
        .update(chats)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .returning();
      return chat ?? null;
    },

    async remove(userId: string, chatId: string): Promise<boolean> {
      const gone = await db
        .delete(chats)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .returning({ id: chats.id });
      return gone.length > 0;
    },
  };
}

export type ChatStore = ReturnType<typeof chatStore>;
