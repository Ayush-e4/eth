import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { messages, users } from "../db/schema";
import { testDb } from "../test/db";
import { notifier } from "./notifier";
import { chatPoster } from "./post";
import { telegramBot } from "./telegram";

let db: Db;
let userId: string;
let sent: { url: string; body: unknown; headers: Record<string, string> }[];
let updates: unknown[];

const fakeFetch = (async (url: string, init: RequestInit) => {
  const body =
    typeof init.body === "string" && url.includes("telegram") ? JSON.parse(init.body) : init.body;
  sent.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> });
  if (url.endsWith("/getMe"))
    return Response.json({ ok: true, result: { username: "AgentNetAlertsBot" } });
  if (url.endsWith("/getUpdates")) {
    const next = updates.shift();
    if (!next) await new Promise((r) => setTimeout(r, 20));
    return Response.json({ ok: true, result: next ? [next] : [] });
  }
  return Response.json({ ok: true });
}) as unknown as typeof fetch;

const make = (telegramToken?: string) =>
  notifier(db, { ntfyUrl: "https://ntfy.example", telegramToken, fetchImpl: fakeFetch });

beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  userId = u?.id ?? "";
  sent = [];
  updates = [];
});

describe("alerts outside the app", () => {
  it("ntfy: a private topic per user, alerts go to it with a link back", async () => {
    const n = make();
    const t = await n.linkNtfy(userId);
    expect(t?.topic).toMatch(/^agentnet-[A-Za-z0-9_-]{24}$/);
    expect(await n.linkNtfy(userId)).toEqual(t); // the same one again
    expect(await n.channels(userId)).toMatchObject({ telegram: null, telegramAvailable: false });
    expect(
      await n.send(userId, { title: "Goa trip", text: "Fare dropped", url: "http://app/chat/1" }),
    ).toBe(1);
    expect(sent).toEqual([
      {
        url: `https://ntfy.example/${t?.topic}`,
        body: "Fare dropped",
        headers: expect.objectContaining({ Title: "Goa trip", Click: "http://app/chat/1" }),
      },
    ]);
    await n.unlink(userId, "ntfy");
    expect(await n.send(userId, { title: "x", text: "y" })).toBe(0);
  });

  it("Telegram: linked by tapping Start on the bot's link, with a one-time code", async () => {
    const n = make("123:abc");
    const url = await n.startTelegram(userId);
    expect(url).toMatch(/^https:\/\/t\.me\/AgentNetAlertsBot\?start=[A-Za-z0-9_-]{12}$/);
    expect(await n.send(userId, { title: "x", text: "y" })).toBe(0); // not linked yet
    const code = url?.split("=")[1] ?? "";
    updates.push(
      { update_id: 1, message: { chat: { id: 42 }, text: "/start wrongcode1" } },
      { update_id: 2, message: { chat: { id: 42 }, text: `/start ${code}` } },
    );
    const stop = telegramBot(n);
    await vi.waitFor(async () =>
      expect((await n.channels(userId)).telegram).toEqual({ linked: true }),
    );
    expect(await n.finishTelegram(code, "99")).toBeNull(); // used up
    sent = [];
    await n.send(userId, { title: "Goa trip", text: "PriceGuard saved ₹249" });
    expect(sent[0]).toMatchObject({
      body: { chat_id: "42", text: "Goa trip\n\nPriceGuard saved ₹249" },
    });
    // Linking the same Telegram chat from another account moves it there.
    const [other] = await db.insert(users).values({ isDemo: true }).returning();
    const url2 = await n.startTelegram(other?.id ?? "");
    updates.push({
      update_id: 3,
      message: { chat: { id: 42 }, text: `/start ${url2?.split("=")[1]}` },
    });
    await vi.waitFor(async () =>
      expect((await n.channels(other?.id ?? "")).telegram).toEqual({ linked: true }),
    );
    expect((await n.channels(userId)).telegram).toBeNull();
    userId = other?.id ?? "";
    updates.push({ update_id: 4, message: { chat: { id: 42 }, text: "/stop" } });
    await vi.waitFor(async () => expect((await n.channels(userId)).telegram).toBeNull());
    stop();
  });

  it("a message posted while nobody's in the chat nudges the chat's owner", async () => {
    const n = make();
    await n.linkNtfy(userId);
    const chat = await chatStore(db).create({
      id: userId,
      defaultMode: "auto",
      defaultLimitUnits: 300_000n,
    } as never);
    await chatPoster(db, n, "http://app")(chat.id, "AirNest finished the job from earlier.");
    expect(await db.select().from(messages).where(eq(messages.chatId, chat.id))).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      body: "AirNest finished the job from earlier.",
      headers: expect.objectContaining({ Click: `http://app/chat/${chat.id}` }),
    });
  });
});
