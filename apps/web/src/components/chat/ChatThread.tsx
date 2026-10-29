"use client";

import type { ChatMode } from "@eth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatSummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { sendMessage } from "@/lib/stream";
import { PENDING_KEY } from "./ChatHome";
import { Composer } from "./Composer";
import { Messages, type Turn } from "./Messages";
import { ModePill } from "./ModePill";

const fromSaved = (m: ChatMessage): Turn => ({
  id: m.id,
  role: m.role,
  text: m.text,
  cards: m.cards,
});

export function ChatThread({ chatId }: { chatId: string }) {
  const { me, chats, refreshChats } = useSession();
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const saved = useRef(0); // messages the server has, for recovering a dropped reply

  /**
   * If the stream drops, the server still finishes the turn and saves it (an agent may already
   * have been paid), so fetch the saved conversation until the reply shows up.
   */
  const recover = useCallback(
    async (count: number) => {
      for (const wait of [5_000, 15_000, 30_000, 60_000]) {
        await new Promise((r) => setTimeout(r, wait));
        const { messages } = await api<{ messages: ChatMessage[] }>(`/chats/${chatId}`).catch(
          () => ({ messages: [] }),
        );
        if (messages.length >= count) {
          setTurns(messages.map(fromSaved));
          saved.current = messages.length;
          return;
        }
      }
    },
    [chatId],
  );

  const send = useCallback(
    async (text: string) => {
      setBusy(true);
      const draftId = `draft-${Date.now()}`;
      setTurns((t) => [
        ...t,
        { id: `user-${Date.now()}`, role: "user", text, cards: [] },
        { id: draftId, role: "assistant", text: "", cards: [], streaming: true },
      ]);
      const patch = (fn: (d: Turn) => Turn) =>
        setTurns((t) => t.map((x) => (x.id === draftId ? fn(x) : x)));
      abort.current = new AbortController();
      let finished = false;
      try {
        for await (const e of sendMessage(chatId, text, abort.current.signal)) {
          if (e.type === "text")
            patch((d) => ({ ...d, text: d.text + e.delta, status: undefined }));
          else if (e.type === "status") patch((d) => ({ ...d, status: e.label }));
          else if (e.type === "card") patch((d) => ({ ...d, cards: [...d.cards, e.card] }));
          else if (e.type === "done") {
            finished = true;
            saved.current += 2;
            patch((d) => ({ ...d, id: e.messageId, text: d.text.trim(), streaming: false }));
          } else if (e.type === "error") {
            finished = true;
            patch((d) => ({ ...d, streaming: false, error: e.message }));
          }
        }
      } catch {
        // handled below: no "done" means the reply is still being saved on the server
      } finally {
        if (!finished && !abort.current?.signal.aborted) {
          patch((d) => ({
            ...d,
            status: "Still working. The reply appears here once it's saved.",
          }));
          void recover(saved.current + 2); // our message and the reply
        } else {
          patch((d) => ({ ...d, streaming: false }));
        }
        setBusy(false);
        void refreshChats(); // the first message names the chat
      }
    },
    [chatId, refreshChats, recover],
  );

  useEffect(() => {
    let live = true;
    api<{ chat: ChatSummary; messages: ChatMessage[] }>(`/chats/${chatId}`)
      .then(({ chat, messages }) => {
        if (!live) return;
        setChat(chat);
        setTurns(messages.map(fromSaved));
        saved.current = messages.length;
        const pending = sessionStorage.getItem(PENDING_KEY(chatId));
        if (pending) {
          sessionStorage.removeItem(PENDING_KEY(chatId));
          void send(pending);
        }
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [chatId, send]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll down whenever the conversation changes
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const changeMode = async (p: { mode?: ChatMode; limitUnits?: string }) => {
    const { chat: updated } = await api<{ chat: ChatSummary }>(`/chats/${chatId}`, {
      method: "PATCH",
      body: p,
    });
    setChat(updated);
  };

  if (missing)
    return (
      <p className="p-10 text-center text-ink-3">This chat doesn't exist, or it isn't yours.</p>
    );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#F1EEE8] px-6 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-base font-semibold">
            {chats.find((c) => c.id === chatId)?.title ?? chat?.title ?? "…"}
          </h1>
          <span className="rounded-full bg-side px-2.5 py-0.5 text-xs font-medium text-ink-3">
            Concierge
          </span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-7 px-6 pt-8 pb-6">
        <Messages
          turns={turns}
          onReply={send}
          busy={busy}
          ctx={{ chatId, isDemo: me?.isDemo ?? false }}
        />
      </main>
      <div className="sticky bottom-0 mx-auto w-full max-w-[800px] bg-gradient-to-t from-white via-white px-6 pt-4 pb-5">
        <Composer
          onSend={send}
          disabled={busy}
          placeholder="Reply, or ask something else"
          toolbar={
            chat && <ModePill mode={chat.mode} limitUnits={chat.limitUnits} onChange={changeMode} />
          }
        />
      </div>
      {/* After the message box, so scrolling here shows the newest reply above it. */}
      <div ref={bottom} />
    </div>
  );
}
