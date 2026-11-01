import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { signInLinks } from "../auth/links";
import { createSession, SESSION_COOKIE } from "../auth/session";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { chats, type MandateRow, notifyChannels, users } from "../db/schema";
import { covers } from "../hiring/mandates";
import type { HiringService } from "../hiring/service";
import { testDb } from "../test/db";
import { env } from "../test/hiring";
import type { PasskeyWallets } from "../wallet/service";

const ORIGIN = "http://localhost:3000";
let db: Db;
let app: ReturnType<typeof createApp>;
let userId: string;
let cookie: string;
let ready: boolean;
const links = signInLinks();

beforeEach(async () => {
  db = await testDb();
  ready = true;
  const wallets = {
    get: async () => (ready ? { status: "ready" } : null),
    prepare: async () => ({ opId: "op-1", options: { challenge: "abc" } }),
  } as unknown as PasskeyWallets;
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    hiring: { env, service: { noteUserMessage: () => {} } as unknown as HiringService },
    wallets,
    links,
  });
  const [u] = await db.insert(users).values({ displayName: "Asha" }).returning();
  userId = u?.id ?? "";
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("the Telegram budget", () => {
  it("hands back the Telegram chat and a 7-day, any-agent limit to approve with Face ID", async () => {
    expect(
      (await call("POST", "/notifications/telegram/budget", { budgetUnits: "300000" })).status,
    ).toBe(409); // not linked
    await db.insert(notifyChannels).values({ userId, channel: "telegram", address: "42" });
    const res = await call("POST", "/notifications/telegram/budget", { budgetUnits: "300000" });
    const { chatId, card } = (await res.json()) as {
      chatId: string;
      card: Record<string, unknown>;
    };
    expect(card).toMatchObject({
      type: "limit",
      budgetUnits: "300000",
      perPaymentCapUnits: "100000",
      payees: [],
    });
    expect(Number(card.expiresAt) - Date.now() / 1000).toBeGreaterThan(6.9 * 24 * 3600);
    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
    expect(chat).toMatchObject({ title: "Telegram", mode: "auto", limitUnits: 300_000n });
    const [link] = await db.select().from(notifyChannels);
    expect(link?.appChatId).toBe(chatId); // the bot talks into this same chat

    // …and the chat's Face ID step takes that card as it is (it names no agents).
    const prep = await call("POST", `/chats/${chatId}/mandate/face-id`, { card });
    expect(prep.status).toBe(200);
    expect(await prep.json()).toMatchObject({ opId: "op-1" });
  });

  it("needs a passkey account's wallet", async () => {
    ready = false;
    await db.insert(notifyChannels).values({ userId, channel: "telegram", address: "42" });
    const res = await call("POST", "/notifications/telegram/budget", { budgetUnits: "300000" });
    expect(res.status).toBe(409);
  });

  it("a limit naming no agents covers any agent", () => {
    expect(covers({ payees: [] } as unknown as MandateRow, "0xabc")).toBe(true);
    expect(covers({ payees: ["0xdef"] } as unknown as MandateRow, "0xabc")).toBe(false);
  });
});

describe("one-time sign-in links", () => {
  it("sign you in once and go where they point; then they're spent", async () => {
    const t = links.make(userId, "/watchers?telegram=budget");
    const res = await app.request(`/auth/link?t=${t}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/watchers?telegram=budget");
    expect(res.headers.get("set-cookie")).toMatch(/eth_session=.+HttpOnly/i);
    const again = await app.request(`/auth/link?t=${t}`);
    expect(again.headers.get("location")).toBe("/login?expired=1");
  });
});
