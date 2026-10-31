"use client";

import type { ChatMode } from "@eth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatSummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { sendMessage } from "@/lib/stream";
import { AgentBanner } from "./AgentBanner";
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

  // Agents finish later (a delivery, a fare drop, a payment to review) and the server posts it
  // here: look for new messages every few seconds while this chat is open and idle.
  const busyNow = useRef(false);
  busyNow.current = busy;
  useEffect(() => {
    const t = setInterval(async () => {
      if (busyNow.current || document.hidden) return;
      const got = await api<{ messages: ChatMessage[] }>(`/chats/${chatId}`).catch(() => null);
      if (!got || busyNow.current || got.messages.length <= saved.current) return;
      setTurns(got.messages.map(fromSaved));
      saved.current = got.messages.length;
    }, 6000);
    return () => clearInterval(t);
  }, [chatId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll down whenever the conversation changes
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const unpin = async () => {
    const { chat: updated } = await api<{ chat: ChatSummary }>(`/chats/${chatId}`, {
      method: "PATCH",
      body: { agent: null },
    });
    setChat(updated);
    void refreshChats();
  };

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
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col md:min-h-dvh">
      <header className="sticky top-14 z-20 flex items-center justify-between gap-3 border-b border-[#F1EEE8] bg-white/95 px-4 py-2.5 backdrop-blur sm:px-6 md:top-0 md:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-base font-semibold">
            {chats.find((c) => c.id === chatId)?.title ?? chat?.title ?? "…"}
          </h1>
          <span className="flex-none rounded-full bg-side px-2.5 py-0.5 text-xs font-medium text-ink-3">
            {chat?.agent ? `with ${chat.agent.name}` : "Concierge"}
          </span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-6 px-4 pt-6 pb-4 sm:gap-7 sm:px-6 sm:pt-8">
        {chat?.agent && <AgentBanner agent={chat.agent} onUnpin={unpin} />}
        <Messages
          turns={turns}
          onReply={send}
          busy={busy}
          ctx={{ chatId, isDemo: me?.isDemo ?? false, faceId: me?.wallet?.status === "ready" }}
        />
      </main>
      <div className="sticky bottom-0 z-20 mx-auto w-full max-w-[800px] bg-gradient-to-t from-white from-60% to-white/0 px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
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
