import type { Card } from "@eth/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { SignInLinks } from "../auth/links";
import { runTurn } from "../chats/turn";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import { notifyChannels, users } from "../db/schema";
import type { DemoQuotaCheck } from "../demo/quotas";
import type { Notifier } from "./notifier";
import { telegramAppChat, telegramLink } from "./telegram-app-chat";
import { telegramReply } from "./telegram-format";

const BUDGET_PAGE = "/watchers?telegram=budget";

/**
 * Chatting with the concierge on Telegram. A linked chat's messages go to that person's own
 * AgentNet chat ("Telegram"), so the conversation is in the app too: same concierge, same
 * limits, same agents. One message at a time per person; Telegram shows "typing…" meanwhile.
 * Hires spend from the Telegram budget; when there isn't one, the reply's button opens the app,
 * already signed in (a one-time link), where Face ID approves it.
 */
export function telegramChat(
  db: Db,
  d: {
    notify: Notifier;
    concierge: Concierge;
    appOrigin: string;
    links?: SignInLinks | null;
    onUserMessage?: (chatId: string, text: string) => unknown;
    demo?: DemoQuotaCheck | null;
    log?: (line: string) => void;
  },
) {
  const busy = new Set<string>();
  const send = (to: string, text: string, reply_markup?: unknown) =>
    d.notify
      .tg("sendMessage", {
        chat_id: to,
        text,
        disable_web_page_preview: true,
        ...(reply_markup ? { reply_markup } : {}),
      })
      .catch(() => null);

  /** Where a reply's button goes: the Telegram budget, signed in, if that's what it needs. */
  const buttonLink = (userId: string, chatId: string, cards: Card[]) => {
    const chatPage = `${d.appOrigin}/chat/${chatId}`;
    const needsBudget = cards.some((c) => c.type === "limit");
    if (!d.links) return needsBudget ? `${d.appOrigin}${BUDGET_PAGE}` : chatPage;
    const path = needsBudget ? BUDGET_PAGE : `/chat/${chatId}`;
    return `${d.appOrigin}/api/auth/link?t=${d.links.make(userId, path)}`;
  };

  const onText = async (tgChatId: string, text: string) => {
    const link = await telegramLink(db, { tgChatId });
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
      const chat = await telegramAppChat(db, user, link.appChatId ?? null);
      const turn = await runTurn(db, d.concierge, chat, user, text, {
        onUserMessage: d.onUserMessage,
        channel: "telegram",
      });
      const reply = telegramReply(turn.text, turn.cards, buttonLink(user.id, chat.id, turn.cards));
      await send(tgChatId, reply.text || "Done.", reply.markup);
    } catch (err) {
      d.log?.(`telegram chat failed: ${String(err).slice(0, 160)}`);
      await send(tgChatId, "Something went wrong there. Try again in a moment.");
    } finally {
      clearInterval(keepTyping);
      busy.delete(tgChatId);
    }
  };

  /**
   * A turn of the Telegram chat that happened in the app (e.g. "I've approved the limit" after
   * Face ID): send its reply to Telegram too, where the person is waiting for it.
   */
  const mirror = async (chatId: string, reply: { text: string; cards: Card[] }) => {
    const [row] = await db
      .select()
      .from(notifyChannels)
      .where(
        and(
          eq(notifyChannels.channel, "telegram"),
          eq(notifyChannels.appChatId, chatId),
          isNull(notifyChannels.linkCode),
        ),
      );
    if (!row) return;
    const r = telegramReply(reply.text, reply.cards, buttonLink(row.userId, chatId, reply.cards));
    await send(row.address, r.text || "Done.", r.markup);
  };

  return { onText, mirror };
}
