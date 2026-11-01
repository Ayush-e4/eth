import { and, eq, isNull } from "drizzle-orm";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { type Chat, chats, notifyChannels, type User } from "../db/schema";

/** A person's linked Telegram: the chat id there, and the AgentNet chat it talks into. */
export async function telegramLink(db: Db, by: { userId: string } | { tgChatId: string }) {
  const [row] = await db
    .select()
    .from(notifyChannels)
    .where(
      and(
        eq(notifyChannels.channel, "telegram"),
        isNull(notifyChannels.linkCode),
        "userId" in by
          ? eq(notifyChannels.userId, by.userId)
          : eq(notifyChannels.address, by.tgChatId),
      ),
    );
  return row ?? null;
}

/** The AgentNet chat a Telegram chat talks into ("Telegram"; made on first use, or if deleted). */
export async function telegramAppChat(
  db: Db,
  user: Pick<User, "id" | "defaultMode" | "defaultLimitUnits">,
  appChatId: string | null,
): Promise<Chat> {
  const store = chatStore(db);
  const existing = appChatId ? await store.get(user.id, appChatId).catch(() => null) : null;
  if (existing) return existing;
  const chat = await store.create(user);
  await db.update(chats).set({ title: "Telegram" }).where(eq(chats.id, chat.id));
  await db
    .update(notifyChannels)
    .set({ appChatId: chat.id })
    .where(and(eq(notifyChannels.userId, user.id), eq(notifyChannels.channel, "telegram")));
  return { ...chat, title: "Telegram" };
}
