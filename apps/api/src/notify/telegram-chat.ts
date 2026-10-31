import { and, eq, isNull } from "drizzle-orm";
import { chatStore } from "../chats/store";
import { runTurn } from "../chats/turn";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import { type Chat, chats, notifyChannels, type User, users } from "../db/schema";
import type { DemoQuotaCheck } from "../demo/quotas";
import type { Notifier } from "./notifier";
import { telegramReply } from "./telegram-format";

/**
 * Chatting with the concierge on Telegram. A linked chat's messages go to that person's own
 * AgentNet chat ("Telegram"), so the conversation is in the app too: same concierge, same
 * limits, same agents. One message at a time per person; Telegram shows "typing…" meanwhile.
 */
export function telegramChat(
  db: Db,
  d: {
    notify: Notifier;
    concierge: Concierge;
    appOrigin: string;
    onUserMessage?: (chatId: string, text: string) => unknown;
    demo?: DemoQuotaCheck | null;
    log?: (line: string) => void;
  },
) {
  const busy = new Set<string>();
  const store = chatStore(db);
  const send = (to: string, text: string, reply_markup?: unknown) =>
    d.notify
      .tg("sendMessage", {
        chat_id: to,
        text,
        disable_web_page_preview: true,
        ...(reply_markup ? { reply_markup } : {}),
      })
      .catch(() => null);

  /** The AgentNet chat this Telegram chat talks into (made on first use, or again if deleted). */
  async function appChat(user: User, appChatId: string | null): Promise<Chat> {
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

  return async (tgChatId: string, text: string) => {
    const [link] = await db
      .select()
      .from(notifyChannels)
      .where(
        and(
          eq(notifyChannels.channel, "telegram"),
          eq(notifyChannels.address, tgChatId),
          isNull(notifyChannels.linkCode),
        ),
      );
    const [user] = link ? await db.select().from(users).where(eq(users.id, link.userId)) : [];
    if (!link || !user)
      return send(
        tgChatId,
        "To chat here, link this Telegram first: in AgentNet open Watchers → Get alerts → Connect Telegram.",
      );
    if (busy.has(tgChatId)) return send(tgChatId, "Still working on your last message…");
    busy.add(tgChatId);
    const typing = () =>
      void d.notify.tg("sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => {});
    typing();
    const keepTyping = setInterval(typing, 4500);
    try {
      const over = user.isDemo ? await d.demo?.canSend(user.id) : null;
      if (over) return await send(tgChatId, over);
      const chat = await appChat(user, link.appChatId ?? null);
      const turn = await runTurn(db, d.concierge, chat, user, text, {
        onUserMessage: d.onUserMessage,
      });
      const reply = telegramReply(turn.text, turn.cards, `${d.appOrigin}/chat/${chat.id}`);
      await send(tgChatId, reply.text || "Done.", reply.markup);
    } catch (err) {
      d.log?.(`telegram chat failed: ${String(err).slice(0, 160)}`);
      await send(tgChatId, "Something went wrong there. Try again in a moment.");
    } finally {
      clearInterval(keepTyping);
      busy.delete(tgChatId);
    }
  };
}
