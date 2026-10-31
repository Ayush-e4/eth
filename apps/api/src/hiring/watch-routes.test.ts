import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { fareWatches } from "../db/schema";
import { testDb } from "../test/db";

const ORIGIN = "http://localhost:3000";
let db: Db;
let app: ReturnType<typeof createApp>;

const signIn = async () =>
  (await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } })).headers
    .get("set-cookie")
    ?.split(";")[0] ?? "";
const get = (path: string, cookie: string) =>
  app.request(path, { headers: { cookie, origin: ORIGIN } });

/** A user with one chat and one fare watch in it. */
async function userWithAWatch(watchId: string) {
  const cookie = await signIn();
  const res = await app.request("/chats", { method: "POST", headers: { cookie, origin: ORIGIN } });
  const { chat } = (await res.json()) as { chat: { id: string } };
  await db.insert(fareWatches).values({
    watchId,
    chatId: chat.id,
    agent: "0xfw",
    endpoint: "http://farewatch",
    input: { origin: "BOM", destination: "GOI", date: "2026-12-04" },
  });
  return { cookie, chatId: chat.id };
}

beforeEach(async () => {
  db = await testDb();
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }));
});

describe("the Watchers page", () => {
  it("lists the user's watches from all their chats, and nobody else's", async () => {
    const mine = await userWithAWatch("0xw1");
    await userWithAWatch("0xw2");
    const body = (await (await get("/watches", mine.cookie)).json()) as { watches: unknown[] };
    expect(body.watches).toEqual([
      expect.objectContaining({
        watchId: "0xw1",
        chatId: mine.chatId,
        status: "watching",
        input: { origin: "BOM", destination: "GOI", date: "2026-12-04" },
      }),
    ]);
    expect((await get("/watches", "")).status).toBe(401);
  });
});
