import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { notifyChannels as table } from "../db/schema";

export interface Alert {
  title: string;
  text: string;
  url?: string; // where to look (the chat), opened from the notification
}

export interface NotifyConfig {
  ntfyUrl: string; // https://ntfy.sh, or a self-hosted server
  telegramToken?: string; // a bot from @BotFather; Telegram is off without it
  fetchImpl?: typeof fetch;
}

const code = () => randomBytes(9).toString("base64url");

/**
 * Alerts outside the app, to the channels each user linked: an ntfy topic (a private random
 * name: whoever knows it can read it, so it's long and never shown to anyone else) and/or a
 * Telegram chat linked by tapping Start on our bot with a one-time code. Sending is best effort:
 * the chat message is the record; an alert is a nudge to go and look.
 */
export function notifier(db: Db, cfg: NotifyConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const tg = (method: string, body: unknown) =>
    fetchImpl(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    }).then((r) => r.json() as Promise<{ ok: boolean; result?: unknown }>);
  let botName: Promise<string | null> | null = null;

  const senders: Record<string, (to: string, a: Alert) => Promise<unknown>> = {
    ntfy: (topic, a) =>
      fetchImpl(`${cfg.ntfyUrl}/${topic}`, {
        method: "POST",
        headers: { Title: a.title, ...(a.url ? { Click: a.url } : {}), Tags: "bell" },
        body: a.text,
        signal: AbortSignal.timeout(10_000),
      }),
    telegram: (chatId, a) =>
      tg("sendMessage", {
        chat_id: chatId,
        text: `${a.title}\n\n${a.text}${a.url ? `\n\n${a.url}` : ""}`,
        disable_web_page_preview: true,
      }),
  };

  const mine = (userId: string) => db.select().from(table).where(eq(table.userId, userId));

  return {
    telegram: !!cfg.telegramToken,
    tg,

    /** The bot's @name, for the "Connect Telegram" link (null when Telegram is off). */
    botName() {
      if (!cfg.telegramToken) return Promise.resolve(null);
      botName ??= tg("getMe", {})
        .then((r) => (r.result as { username?: string } | undefined)?.username ?? null)
        .catch(() => null);
      return botName;
    },

    /** Send to every channel the user linked (and finished linking). */
    async send(userId: string, a: Alert) {
      const rows = (await mine(userId)).filter((r) => r.address && !r.linkCode);
      await Promise.all(
        rows.map((r) =>
          r.channel === "telegram" && !cfg.telegramToken
            ? null
            : senders[r.channel]?.(r.address, a).catch(() => null),
        ),
      );
      return rows.length;
    },

    /** What the user has linked (topics are theirs to see; nobody else's). */
    async channels(userId: string) {
      const rows = await mine(userId);
      const ntfy = rows.find((r) => r.channel === "ntfy");
      const tgRow = rows.find((r) => r.channel === "telegram");
      return {
        ntfy: ntfy ? { topic: ntfy.address, url: `${cfg.ntfyUrl}/${ntfy.address}` } : null,
        telegram: tgRow ? { linked: !tgRow.linkCode } : null,
        telegramAvailable: !!cfg.telegramToken,
      };
    },

    /** A private ntfy topic for the user (the same one if they have it already). */
    async linkNtfy(userId: string) {
      const topic = `agentnet-${code()}${code()}`;
      await db
        .insert(table)
        .values({ userId, channel: "ntfy", address: topic })
        .onConflictDoNothing();
      return (await this.channels(userId)).ntfy;
    },

    /** A one-time code; the Telegram link opens the bot, which finishes with /start <code>. */
    async startTelegram(userId: string) {
      const name = await this.botName();
      if (!name) return null;
      const linkCode = code();
      await db
        .insert(table)
        .values({ userId, channel: "telegram", address: "", linkCode })
        .onConflictDoUpdate({
          target: [table.userId, table.channel],
          set: { address: "", linkCode },
        });
      return `https://t.me/${name}?start=${linkCode}`;
    },

    /** The bot got "/start <code>": that code's user now gets alerts in this chat. */
    async finishTelegram(linkCode: string, chatId: string) {
      const [row] = await db
        .update(table)
        .set({ address: chatId, linkCode: null })
        .where(and(eq(table.channel, "telegram"), eq(table.linkCode, linkCode)))
        .returning({ userId: table.userId });
      return row?.userId ?? null;
    },

    async unlink(userId: string, channel: string) {
      await db.delete(table).where(and(eq(table.userId, userId), eq(table.channel, channel)));
    },

    /** Telegram "/stop": stop sending to that chat, whoever linked it. */
    async unlinkChat(chatId: string) {
      await db.delete(table).where(and(eq(table.channel, "telegram"), eq(table.address, chatId)));
    },
  };
}

export type Notifier = ReturnType<typeof notifier>;
