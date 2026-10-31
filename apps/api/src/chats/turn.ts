import type { Card, ConciergeEvent } from "@eth/shared";
import { asc, eq } from "drizzle-orm";
import type { Concierge } from "../concierge/concierge";
import type { Db } from "../db/client";
import { type Chat, hires, type User } from "../db/schema";
import { withCardNotes } from "./card-notes";
import { chatStore } from "./store";

/**
 * One turn of a chat: save what the user said, let the concierge answer (it may quote and hire
 * agents, live through `emit`), save the answer. Shared by the web chat and the Telegram bot.
 */
export async function runTurn(
  db: Db,
  concierge: Concierge,
  chat: Chat,
  user: Pick<User, "id" | "displayName" | "homeCity">,
  text: string,
  opts: {
    onUserMessage?: (chatId: string, text: string) => unknown;
    emit?: (e: ConciergeEvent) => void;
  } = {},
): Promise<{ text: string; cards: Card[]; messageId: string }> {
  const store = chatStore(db);
  const history = (await store.recent(chat.id)).map((m) => ({
    role: m.role,
    text: withCardNotes(m.text, m.cards),
  }));
  await store.add(chat, "user", text);
  await opts.onUserMessage?.(chat.id, text); // e.g. "Approve abc123"

  const hired = (
    await db.select().from(hires).where(eq(hires.chatId, chat.id)).orderBy(asc(hires.createdAt))
  ).map(
    (h) =>
      `${h.title.split(" — ")[0]} did the ${h.skill} job, paid ${(Number(h.feeUnits) / 1e6).toFixed(2)} USDC (tx ${h.hederaTx}); result: ${JSON.stringify(h.result ?? null).slice(0, 600)}`,
  );
  const reply = await concierge({
    history,
    hired,
    text,
    user: { id: user.id, displayName: user.displayName, homeCity: user.homeCity },
    chat: {
      id: chat.id,
      mode: chat.mode,
      limitUnits: chat.limitUnits,
      agentAddress: chat.agentAddress,
      agentName: chat.agentName,
      agentSkill: chat.agentSkill,
    },
    emit: opts.emit ?? (() => {}),
  });
  const saved = await store.add(chat, "assistant", reply.text, reply.cards);
  return { text: reply.text, cards: reply.cards, messageId: saved.id };
}
