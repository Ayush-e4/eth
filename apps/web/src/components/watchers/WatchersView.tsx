"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { HotelGuardCard } from "../chat/HotelGuardCard";
import { WatchCard } from "../chat/WatchCard";

interface Row {
  watchId: string;
  chatId: string;
  chatTitle: string;
  input: { origin?: string; destination?: string; date?: string };
  status: "watching" | "ended" | "stopped" | "booked";
  kind: "fare" | "hotel";
  createdAt: string;
}

const EXAMPLE = "Watch the fare Mumbai to Goa on 4 December and tell me if it drops below ₹3,000";

/** Every agent watching something for the user, from all their chats. */
export function WatchersView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ watches: Row[] }>("/watches")
      .then((r) => setRows(r.watches))
      .catch(() => setError("Couldn't load your watchers."));
  }, []);

  const live = rows?.filter((r) => r.status === "watching") ?? [];
  const earlier = rows?.filter((r) => r.status !== "watching") ?? [];
  const list = (title: string, items: Row[]) =>
    items.length > 0 && (
      <section aria-label={title} className="flex flex-col gap-3">
        <h2 className="text-[15px] font-bold">
          {title} <span className="font-normal text-muted">{items.length}</span>
        </h2>
        {items.map((r) => (
          <div key={r.watchId} className="flex flex-col gap-1.5">
            <Link
              href={`/chat/${r.chatId}`}
              className="self-start text-xs text-teal hover:underline"
            >
              Set in “{r.chatTitle}”
            </Link>
            {r.kind === "hotel" ? (
              <HotelGuardCard
                card={{ type: "watch", watchId: r.watchId, title: "PriceGuard", kind: "hotel" }}
                ctx={{ chatId: r.chatId, isDemo: false, onReply: () => {} }}
              />
            ) : (
              <WatchCard
                card={{ type: "watch", watchId: r.watchId, title: "FareWatch" }}
                ctx={{ chatId: r.chatId, isDemo: false, onReply: () => {} }}
              />
            )}
          </div>
        ))}
      </section>
    );

  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 pt-8 pb-14 sm:px-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-bold tracking-tight">Watchers</h1>
        <p className="text-[15px] leading-relaxed text-ink-3">
          Agents you hired to keep an eye on something. They check on a schedule, and when there's
          news they post it in the chat you set them up in. Each watch was paid once, when you set
          it up.
        </p>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {rows === null && !error && <p className="text-sm text-muted">Loading your watchers…</p>}
      {rows?.length === 0 && (
        <div className="flex flex-col gap-2 rounded-2xl bg-side p-[18px] text-sm">
          <span className="font-semibold">Nothing is being watched yet.</span>
          <span className="text-ink-3">
            Ask in any chat, for example: <em>“{EXAMPLE}”</em>. FareWatch checks the fare for up to
            two weeks and tells you when it drops.
          </span>
          <Link href="/chat" className="self-start text-teal">
            Start a chat
          </Link>
        </div>
      )}
      {list("Watching now", live)}
      {list("Earlier", earlier)}
    </main>
  );
}
