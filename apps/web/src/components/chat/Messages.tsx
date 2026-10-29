"use client";

import type { Card } from "@eth/shared";
import { LogoMark } from "../icons";
import { CardView } from "./Cards";
import { Markdown } from "./Markdown";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  status?: string; // what the concierge is doing right now, while streaming
  streaming?: boolean;
  error?: string;
}

export function Messages({
  turns,
  onReply,
  busy,
}: {
  turns: Turn[];
  onReply: (t: string) => void;
  busy: boolean;
}) {
  return (
    <ol aria-label="Conversation" className="flex flex-col gap-7">
      {turns.map((t) =>
        t.role === "user" ? (
          <li
            key={t.id}
            className="max-w-[78%] self-end rounded-[18px_18px_4px_18px] bg-bubble px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap"
          >
            {t.text}
          </li>
        ) : (
          <li key={t.id} className="flex items-start gap-3.5">
            <span
              aria-hidden
              className="flex size-8 flex-none items-center justify-center rounded-[9px] bg-ink text-white"
            >
              <LogoMark size={17} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <span className="text-[13px] font-semibold">Concierge</span>
              {t.text &&
                (t.streaming ? (
                  <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{t.text}</p>
                ) : (
                  <Markdown text={t.text} />
                ))}
              {t.cards.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cards have no id; a turn's cards never reorder
                <CardView key={`${t.id}-${i}`} card={c} onReply={onReply} disabled={busy} />
              ))}
              {t.streaming && (
                <p role="status" className="flex items-center gap-2 text-sm text-muted">
                  <span aria-hidden className="size-2 animate-pulse rounded-full bg-saffron" />
                  {t.status ?? (t.text ? "Writing" : "Thinking")}
                </p>
              )}
              {t.error && (
                <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
                  {t.error}
                </p>
              )}
            </div>
          </li>
        ),
      )}
    </ol>
  );
}
