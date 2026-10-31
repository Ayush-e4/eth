import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import { chats, messages, notifyChannels, users } from "../db/schema";
import { testDb } from "../test/db";
import type { Notifier } from "./notifier";
import { telegramChat } from "./telegram-chat";
import { telegramReply } from "./telegram-format";

const quotes: Card = {
  type: "quotes",
  skill: "packing",
  reason: "lowest total",
  quotes: [
    {
      key: "0xq",
      title: "PackPal",
      note: "3 days in Goa",
      feeUnits: "10000",
      totalInr: 1,
      track: "delivered 9 of 9",
      reply: "Hire PackPal (q1)",
    },
  ],
} as Card;

let db: Db;
let sent: { method: string; body: Record<string, unknown> }[];
let asked: string[];
const notify = {
  tg: async (method: string, body: unknown) => {
    sent.push({ method, body: body as Record<string, unknown> });
    return { ok: true };
  },
} as unknown as Notifier;
const concierge: Concierge = async (input) => {
  asked.push(input.text);
  return { text: "Here's an agent for that. **PackPal** can do it.", cards: [quotes] };
};
const chat = () =>
  telegramChat(db, { notify, concierge, appOrigin: "https://agentnetai.duckdns.org" });

beforeEach(async () => {
  db = await testDb();
  sent = [];
  asked = [];
  const [u] = await db.insert(users).values({ displayName: "Asha" }).returning();
  await db
    .insert(notifyChannels)
    .values({ userId: u?.id ?? "", channel: "telegram", address: "42" });
});

describe("chatting on Telegram", () => {
  it("a linked chat talks to the concierge in its own AgentNet chat, with buttons", async () => {
    await chat()("42", "Get me a packing list for Goa");
    expect(asked).toEqual(["Get me a packing list for Goa"]);
    expect(sent[0]?.method).toBe("sendChatAction");
    const reply = sent.find((s) => s.method === "sendMessage")?.body;
    expect(reply?.text).toContain("Here's an agent for that. PackPal can do it."); // no markdown
    expect(reply?.text).toContain("1. PackPal: ₹1 · fee 0.01 USDC · delivered 9 of 9");
    expect(reply?.reply_markup).toMatchObject({ keyboard: [[{ text: "Hire PackPal (q1)" }]] });

    const [c] = await db.select().from(chats);
    expect(c?.title).toBe("Telegram");
    expect(
      await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, c?.id ?? "")),
    ).toHaveLength(2);
    await chat()("42", "Hire PackPal (q1)"); // the button's text comes back as a message
    expect(await db.select().from(chats)).toHaveLength(1); // the same chat
  });

  it("tells an unlinked chat how to link", async () => {
    await chat()("99", "hello");
    expect(asked).toEqual([]);
    expect(String(sent[0]?.body.text)).toContain("Connect Telegram");
  });
});

describe("telegramReply", () => {
  it("sends a spending limit to the app (Face ID), with a button when the site is https", () => {
    const limit = { type: "limit", budgetUnits: "300000" } as Card;
    const r = telegramReply("Need a limit first.", [limit], "https://x.example/chat/1");
    expect(r.markup).toEqual({
      inline_keyboard: [[{ text: "Approve with Face ID", url: "https://x.example/chat/1" }]],
    });
    const local = telegramReply("Need a limit first.", [limit], "http://localhost:3000/chat/1");
    expect(local.text).toContain("Open it here: http://localhost:3000/chat/1");
  });
});
