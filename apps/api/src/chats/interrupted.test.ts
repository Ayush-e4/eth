import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats, messages, users } from "../db/schema";
import { testDb } from "../test/db";
import { closeInterruptedTurns, INTERRUPTED_NOTE } from "./interrupted";

describe("closing turns a restart cut off", () => {
  it("answers only recent chats left waiting on a reply", async () => {
    const db = await testDb();
    const [u] = await db.insert(users).values({ isDemo: true }).returning();
    const made = await db
      .insert(chats)
      .values(["cut", "answered", "old"].map((title) => ({ userId: u?.id ?? "", title })))
      .returning();
    const [cut, answered, old] = made.map((c) => c.id);
    const t = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    await db.insert(messages).values([
      { chatId: cut ?? "", role: "user", text: "book it", createdAt: t(1) },
      { chatId: answered ?? "", role: "user", text: "hi", createdAt: t(2) },
      { chatId: answered ?? "", role: "assistant", text: "hello", createdAt: t(1) },
      { chatId: old ?? "", role: "user", text: "long ago", createdAt: t(60) },
    ]);

    expect(await closeInterruptedTurns(db)).toEqual([cut]);
    const thread = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, cut ?? ""))
      .orderBy(asc(messages.createdAt));
    expect(thread.map((m) => [m.role, m.text])).toEqual([
      ["user", "book it"],
      ["assistant", INTERRUPTED_NOTE],
    ]);
    expect(await closeInterruptedTurns(db)).toEqual([]); // once
  });
});
