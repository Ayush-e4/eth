"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api, type ChatSummary } from "@/lib/api";
import { useSession } from "@/lib/session";

/** Starts a chat with just this agent: only it is asked for quotes and only it can be paid. */
export function ChatWithAgent({
  agent,
  name,
  primary = false,
}: {
  agent: string;
  name: string;
  primary?: boolean;
}) {
  const router = useRouter();
  const { refreshChats } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { chat } = await api<{ chat: ChatSummary }>("/chats", {
        method: "POST",
        body: { agent },
      });
      void refreshChats();
      router.push(`/chat/${chat.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the chat");
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className={`flex min-h-10 items-center rounded-xl px-3 text-sm font-semibold disabled:opacity-60 ${primary ? "bg-teal text-white" : "border border-line-2 bg-white text-ink"}`}
      >
        {busy ? "Opening…" : `Chat with ${name}`}
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
