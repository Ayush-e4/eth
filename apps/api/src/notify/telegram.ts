import type { Notifier } from "./notifier";

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Our Telegram bot, reading its own messages (long polling: no public address needed, so it
 * works on a laptop too). "/start <code>" from the app's Connect
 * Telegram link ties this chat to that account; "/stop" unties it; anything else goes to `onText`
 * (chatting with the concierge). Returns a stop function.
 */
export function telegramBot(
  n: Notifier,
  log: (line: string) => void = () => {},
  /** Anything else a person writes: a chat with the concierge (see telegram-chat.ts). */
  onText?: (chatId: string, text: string) => Promise<unknown>,
) {
  if (!n.telegram) return () => {};
  let running = true;
  let offset = 0;
  const reply = (chatId: number, text: string) =>
    n.tg("sendMessage", { chat_id: chatId, text }).catch(() => null);

  async function handle(u: Update) {
    const chatId = u.message?.chat.id;
    const text = u.message?.text?.trim() ?? "";
    if (chatId === undefined) return;
    const start = /^\/start(?:\s+([A-Za-z0-9_-]{6,40}))?$/.exec(text);
    if (start?.[1]) {
      const user = await n.finishTelegram(start[1], String(chatId));
      return reply(
        chatId,
        user
          ? "Linked: AgentNet will send your alerts here (fare drops, agents' news, payments to review). Send /stop to stop."
          : "That link has expired or was used already. Tap Connect Telegram in AgentNet again.",
      );
    }
    if (text === "/stop") {
      await n.unlinkChat(String(chatId));
      return reply(chatId, "Stopped: no more AgentNet alerts here.");
    }
    if (onText && text && !text.startsWith("/")) {
      // Not awaited: a turn can take a minute, and other people's messages shouldn't wait.
      void onText(String(chatId), text.slice(0, 4000)).catch((err) =>
        log(`telegram: ${String(err).slice(0, 120)}`),
      );
      return;
    }
    return reply(
      chatId,
      onText
        ? "Send me a message to chat with the AgentNet concierge, or /stop to stop alerts."
        : "This bot sends AgentNet alerts. Connect it from AgentNet: Watchers → Get alerts.",
    );
  }

  void (async () => {
    while (running) {
      const r = await n
        .tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] })
        .catch(() => null);
      if (!r?.ok) {
        await sleep(5000);
        continue;
      }
      for (const u of (r.result as Update[]) ?? []) {
        offset = u.update_id + 1;
        await handle(u).catch((err) => log(`telegram: ${String(err).slice(0, 120)}`));
      }
    }
  })();
  return () => {
    running = false;
  };
}
