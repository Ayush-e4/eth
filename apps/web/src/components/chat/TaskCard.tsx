"use client";

import type { Card } from "@eth/shared";
import { useEffect, useRef, useState } from "react";
import { api, arkivEntity, usdc } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

type TaskCardData = Extract<Card, { type: "task" }>;

interface Bid {
  ref: string;
  agent: string;
  note: string;
  feeUnits: string;
  totalInr: number | null;
}
interface Bids {
  status: "open" | "closed" | "awarded";
  bids: Bid[];
}

const left = (iso: string) => {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A job posted on Arkiv: bids arrive by themselves and show up live; choosing one hires it. */
export function TaskCard({ card, ctx }: { card: TaskCardData; ctx: CardCtx }) {
  const [data, setData] = useState<Bids | null>(null);
  const [, tick] = useState(0);
  const doneRef = useRef(false);
  doneRef.current = data?.status === "awarded";

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Bids>(`/chats/${ctx.chatId}/open-tasks/${card.task}/bids`)
        .then((b) => !stop && setData(b))
        .catch(() => {});
    void load();
    const t = setInterval(() => {
      tick((n) => n + 1);
      // Stop asking once bidding is over or the job went to someone.
      if (new Date(card.closesAt).getTime() > Date.now() && !doneRef.current) void load();
    }, 6000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [card.task, card.closesAt, ctx.chatId]);

  const status = data?.status ?? "open";
  return (
    <section
      aria-label={`Open task: ${card.title}`}
      className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold">{card.title}</span>
        <span className="rounded-full bg-saffron-soft px-2.5 py-0.5 text-xs font-semibold text-saffron-ink">
          {status === "open" ? `taking bids · ${left(card.closesAt)}` : status}
        </span>
      </div>
      <p className="text-xs text-muted">
        Posted publicly on{" "}
        <a
          className="text-teal"
          href={arkivEntity(card.entityKey)}
          target="_blank"
          rel="noreferrer"
        >
          Arkiv
        </a>
        . Any {card.skill} agent can bid by itself, for a fee up to {usdc(card.maxFeeUnits)} USDC.
      </p>
      {!data?.bids.length ? (
        <p className="text-sm text-ink-3">
          {status === "open"
            ? "Waiting for bids… agents usually answer within a minute."
            : "No bids."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.bids.map((b, i) => (
            <li
              key={b.ref}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2.5"
            >
              <span className="flex min-w-0 flex-[1_1_220px] flex-col">
                <span className="text-sm font-semibold">
                  {b.agent}
                  {i === 0 && <span className="ml-2 text-xs font-normal text-ok">best value</span>}
                </span>
                <span className="text-xs text-muted">{b.note}</span>
              </span>
              <span className="text-right text-sm">
                {b.totalInr !== null && (
                  <span className="block font-semibold">₹{b.totalInr.toLocaleString("en-IN")}</span>
                )}
                <span className="font-mono text-xs text-muted">fee {usdc(b.feeUnits)} USDC</span>
              </span>
              <button
                type="button"
                disabled={ctx.busy || status === "awarded"}
                onClick={() =>
                  ctx.onReply(`Go with ${b.agent}'s bid (${b.ref}) on task ${card.task}`)
                }
                className="flex min-h-10 items-center rounded-xl border border-line-2 bg-white px-3 text-sm font-semibold disabled:opacity-50"
              >
                Choose
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
