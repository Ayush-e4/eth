import { desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages } from "../db/schema";

const RECENT_MS = 15 * 60_000;

export const INTERRUPTED_NOTE =
  "The server restarted while I was working on this, so I stopped there. Any payment still in its undo window was cancelled, so nothing was paid for it; anything already paid is in Tasks. Ask again and I'll carry on.";

/**
 * At startup: a chat whose last message is the user's, sent in the last few minutes, had its
 * reply cut off by the restart (replies are saved when a turn ends). Say so in the chat, so the
 * page stops waiting and the concierge knows next turn. Returns the chats closed.
 */
export async function closeInterruptedTurns(db: Db, now = Date.now()) {
  const last = await db
    .selectDistinctOn([messages.chatId], {
      chatId: messages.chatId,
      role: messages.role,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .orderBy(messages.chatId, desc(messages.createdAt));
  const cut = last.filter((m) => m.role === "user" && now - m.createdAt.getTime() < RECENT_MS);
  for (const m of cut)
    await db
      .insert(messages)
      .values({ chatId: m.chatId, role: "assistant", text: INTERRUPTED_NOTE });
  return cut.map((m) => m.chatId);
}
