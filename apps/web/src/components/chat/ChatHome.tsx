"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type ChatSummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Composer } from "./Composer";

/** The first message is handed to the chat page this way, so it sends once the page is open. */
export const PENDING_KEY = (chatId: string) => `pending:${chatId}`;

const SUGGESTIONS = [
  {
    title: "Plan a Goa weekend for 2 under ₹40k",
    hint: "Travel · flights and hotel agents",
    tone: "bg-saffron-soft text-saffron-ink",
  },
  {
    title: "Which agents can book me a quiet hotel?",
    hint: "See who's on the market",
    tone: "bg-teal-soft text-teal",
  },
  {
    title: "What can agents on AgentNet do for me?",
    hint: "A quick tour",
    tone: "bg-[#E9F3E6] text-[#2F6A2A]",
  },
  {
    title: "Explain how agent fees and limits work",
    hint: "In plain words",
    tone: "bg-bubble text-ink-2",
  },
];

export function ChatHome() {
  const router = useRouter();
  const { me, refreshChats } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      const { chat } = await api<{ chat: ChatSummary }>("/chats", { method: "POST" });
      sessionStorage.setItem(PENDING_KEY(chat.id), text);
      await refreshChats();
      router.push(`/chat/${chat.id}`);
    } catch {
      setError("Couldn't start a chat. Is the API running?");
      setBusy(false);
    }
  };

  const name = me?.displayName ? `, ${me.displayName}` : "";
  return (
    <main className="mx-auto flex w-full max-w-[780px] flex-col gap-9 px-6 pt-16 pb-14">
      <div className="flex flex-col gap-2.5 text-center">
        <h1 className="text-[34px] leading-tight font-bold tracking-tight">
          What can I help with{name}?
        </h1>
        <p className="mx-auto max-w-[560px] text-base leading-relaxed text-ink-3">
          Ask about anything. When something needs doing, I'll find agents on the market and stay
          inside your limit.
        </p>
      </div>
      <Composer onSend={start} disabled={busy} placeholder="Ask anything" />
      {error && (
        <p role="alert" className="text-center text-sm text-bad">
          {error}
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            type="button"
            disabled={busy}
            onClick={() => start(s.title)}
            className="flex gap-3.5 rounded-2xl border border-line bg-white p-4 text-left hover:border-line-2 disabled:opacity-60"
          >
            <span aria-hidden className={`size-10 flex-none rounded-xl ${s.tone}`} />
            <span className="flex flex-col gap-1">
              <span className="text-[15px] leading-snug font-semibold">{s.title}</span>
              <span className="text-[13px] text-muted">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-center text-xs text-muted">
        AgentNet can make mistakes. Check bookings before you travel.
      </p>
    </main>
  );
}
