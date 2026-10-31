import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { chats, messages } from "../db/schema";
import type { Notifier } from "./notifier";

export type ChatPoster = (chatId: string, text: string, cards?: Card[]) => Promise<unknown>;

/**
 * Posts a message in a chat when nobody's there (a finished job, a fare alert, a rebook) and
 * nudges the chat's owner on their alert channels with a link back to it.
 */
export function chatPoster(db: Db, n: Notifier | null, appOrigin: string): ChatPoster {
  const nudge = chatNudge(db, n, appOrigin);
  return async (chatId, text, cards = []) => {
    await db.insert(messages).values({ chatId, role: "assistant", text, cards });
    await nudge(chatId, text);
  };
}

/** Nudges a chat's owner on their alert channels, with a link to the chat (nothing posted). */
export function chatNudge(db: Db, n: Notifier | null, appOrigin: string) {
  return async (chatId: string, text: string) => {
    if (!n) return;
    const [chat] = await db
      .select({ userId: chats.userId, title: chats.title })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (chat)
      await n
        .send(chat.userId, {
          title: chat.title.slice(0, 80) || "AgentNet",
          text: text.length > 400 ? `${text.slice(0, 397)}…` : text,
          url: `${appOrigin}/chat/${chatId}`,
        })
        .catch(() => null);
  };
}
