import type { Card } from "@eth/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { signInLinks } from "../auth/links";
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
const links = signInLinks();
const chat = () =>
  telegramChat(db, { notify, concierge, appOrigin: "https://agentnetai.duckdns.org", links });

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
    await chat().onText("42", "Get me a packing list for Goa");
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
    await chat().onText("42", "Hire PackPal (q1)"); // the button's text comes back as a message
    expect(await db.select().from(chats)).toHaveLength(1); // the same chat
  });

  it("tells the concierge it's on Telegram, and a limit's button signs you in to the budget", async () => {
    let channel: string | undefined;
    const limitConcierge: Concierge = async (input) => {
      channel = input.channel;
      return {
        text: "Your Telegram budget needs approving.",
        cards: [{ type: "limit", budgetUnits: "300000" } as Card],
      };
    };
    await telegramChat(db, {
      notify,
      concierge: limitConcierge,
      appOrigin: "https://x.example",
      links,
    }).onText("42", "book it");
    expect(channel).toBe("telegram");
    const markup = sent.find((s) => s.method === "sendMessage")?.body.reply_markup as {
      inline_keyboard: { text: string; url: string }[][];
    };
    const url = new URL(markup.inline_keyboard[0]?.[0]?.url ?? "");
    expect(url.pathname).toBe("/api/auth/link");
    expect(links.take(url.searchParams.get("t") ?? "")?.path).toBe("/watchers?telegram=budget");
  });

  it("sends a turn made in the app (after approving) on to Telegram", async () => {
    await chat().onText("42", "Get me a packing list");
    const [c] = await db.select().from(chats);
    sent = [];
    await chat().mirror(c?.id ?? "", { text: "Booked: PackPal is on it.", cards: [] });
    expect(sent[0]).toMatchObject({
      method: "sendMessage",
      body: { chat_id: "42", text: "Booked: PackPal is on it." },
    });
    sent = [];
    await chat().mirror("00000000-0000-0000-0000-000000000000", { text: "x", cards: [] });
    expect(sent).toEqual([]); // not a Telegram chat: nothing sent
  });

  it("says straight away when a payment is waiting out its undo window", async () => {
    const paying: Concierge = async (input) => {
      input.emit({
        type: "card",
        card: {
          type: "payment",
          scheduleId: "0.0.1",
          executesAt: "2026-11-01T18:25:49Z",
          title: "StayWise",
          feeUnits: "40000",
        } as Card,
      });
      return { text: "Booked!", cards: [] };
    };
    await telegramChat(db, {
      notify,
      concierge: paying,
      appOrigin: "https://x.example",
      links,
    }).onText("42", "Go with StayWise (q5)");
    const texts = sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text));
    expect(texts[0]).toMatch(/^0\.04 USDC to StayWise pays at 11:55 pm .*Booking now…$/i);
    expect(texts[1]).toBe("Booked!");
  });

  it("tells an unlinked chat how to link", async () => {
    await chat().onText("99", "hello");
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
