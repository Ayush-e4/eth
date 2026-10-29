"use client";

import type { Card } from "@eth/shared";
import { useState } from "react";
import { ApiError, api, usdc } from "@/lib/api";
import { createMandateInWallet } from "@/lib/wallet";
import { CheckIcon, ShieldIcon } from "../icons";

type Of<T extends Card["type"]> = Extract<Card, { type: T }>;
export interface CardCtx {
  chatId: string;
  isDemo: boolean;
  onReply: (text: string) => void;
  busy?: boolean;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const btn =
  "flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-50";

/** Live quotes for one job; tapping one tells the concierge which to hire. */
export function QuotesCard({ card, ctx }: { card: Of<"quotes">; ctx: CardCtx }) {
  return (
    <section aria-label={`${card.skill} quotes`} className="flex flex-col gap-3">
      <span className="text-[13px] text-ink-3">
        <span className="font-semibold text-ink">Quotes for {card.skill}</span> · {card.reason}
      </span>
      <div className="flex flex-wrap gap-3">
        {card.quotes.map((q, i) => (
          <article
            key={q.key}
            className={`flex flex-[1_1_260px] flex-col gap-3 rounded-2xl bg-white p-4 ${i === 0 ? "border-2 border-teal" : "border border-line"}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold">{q.title}</span>
              {i === 0 && (
                <span className="ml-auto rounded-full bg-saffron-soft px-2.5 py-0.5 text-xs font-bold text-saffron-ink">
                  Best value
                </span>
              )}
            </div>
            <p className="text-[13px] leading-relaxed text-ink-3">{q.note}</p>
            <div className="mt-auto flex items-end justify-between gap-3 border-t border-[#F1EEE8] pt-3">
              <span className="flex flex-col">
                <span className="text-xl font-bold">
                  {q.totalInr
                    ? inr(q.totalInr)
                    : q.itemTotal
                      ? `${q.itemTotal} ${q.itemCurrency ?? ""}`
                      : "—"}
                </span>
                <span className="text-xs text-muted">
                  agent fee <span className="font-mono">{usdc(q.feeUnits)} USDC</span>
                </span>
              </span>
              <button
                type="button"
                disabled={ctx.busy}
                onClick={() => ctx.onReply(q.reply)}
                className={`${btn} ${i === 0 ? "bg-teal text-white" : "border border-line-2 bg-white"}`}
              >
                Choose
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * The chat's spending limit on Hedera. Wallet users sign it in MetaMask (two transactions:
 * allow USDC, then create the limit); demo users approve it with the shared test wallet.
 */
export function LimitCard({ card, ctx }: { card: Of<"limit">; ctx: CardCtx }) {
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    setState("working");
    setError(null);
    try {
      const body = ctx.isDemo
        ? { demo: true, card }
        : { mandateId: (await createMandateInWallet(card)).toString(), card };
      await api(`/chats/${ctx.chatId}/mandate`, { method: "POST", body });
      setState("done");
      ctx.onReply("I've approved the spending limit. Go ahead.");
    } catch (err) {
      setState("idle");
      const code = (err as { code?: number }).code;
      setError(
        code === 4001
          ? "You cancelled in MetaMask."
          : err instanceof ApiError
            ? err.message
            : "Couldn't set the limit. Try again.",
      );
    }
  };
  return (
    <section
      aria-label="Approve a spending limit"
      className="flex flex-col gap-3.5 rounded-2xl border border-warm-line bg-warm p-[18px]"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-[30px] items-center justify-center rounded-full border border-warm-line bg-saffron-soft text-saffron-ink"
        >
          <ShieldIcon size={16} />
        </span>
        <span className="text-[15px] font-bold">Set a spending limit for this chat</span>
      </div>
      <p className="text-sm leading-relaxed text-[#5C3A00]">
        Up to <strong className="font-mono">{usdc(card.budgetUnits)} USDC</strong> in agent fees, at
        most <span className="font-mono">{usdc(card.perPaymentCapUnits)}</span> per payment, only to{" "}
        <strong>{card.payees.map((p) => p.name).join(", ")}</strong>, for the next 24 hours. Hedera
        enforces it: nobody can spend past it.
      </p>
      {state === "done" ? (
        <p role="status" className="flex items-center gap-2 text-sm font-semibold text-ok">
          <CheckIcon size={16} /> Limit set on Hedera
        </p>
      ) : (
        <button
          type="button"
          onClick={approve}
          disabled={state === "working" || ctx.busy}
          className={`${btn} self-start bg-teal text-white`}
        >
          {state === "working"
            ? ctx.isDemo
              ? "Setting it on Hedera…"
              : "Confirm in MetaMask…"
            : ctx.isDemo
              ? "Approve with the demo wallet"
              : "Approve in MetaMask"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}

/** "Ask first" chats: one payment, one approval. The server checks the code. */
export function ApprovalCard({ card, ctx }: { card: Of<"approval">; ctx: CardCtx }) {
  return (
    <section
      aria-label="Approval needed"
      className="flex flex-col gap-3 rounded-2xl border border-warm-line bg-warm p-[18px]"
    >
      <span className="text-[15px] font-bold">{card.title}?</span>
      <p className="text-sm leading-relaxed text-[#5C3A00]">{card.detail}</p>
      <p className="text-sm text-[#5C3A00]">
        Agent fee <strong className="font-mono">{usdc(card.feeUnits)} USDC</strong>, from this
        chat's limit.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={ctx.busy}
          onClick={() => ctx.onReply(`Approve ${card.code}`)}
          className={`${btn} bg-teal text-white`}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={ctx.busy}
          onClick={() => ctx.onReply(`Decline ${card.code}`)}
          className={`${btn} border border-line-2 bg-white`}
        >
          Decline
        </button>
      </div>
    </section>
  );
}

/** An agent was paid and did the job, with proof anyone can check. */
export function HiredCard({ card }: { card: Of<"hired"> }) {
  return (
    <div className="flex flex-col gap-2">
      <HiredRow card={card} />
      {card.subHires?.length ? (
        <section
          aria-label={`Agents ${card.title} hired`}
          className="ml-6 flex flex-col gap-2 border-l-2 border-line pl-4"
        >
          <p className="text-xs text-muted">
            {card.title} hired {card.subHires.length === 1 ? "this agent" : "these agents"}, paying
            from limit #{card.subMandateId}, a slice of this chat's limit:
          </p>
          {card.subHires.map((s) => (
            <HiredRow key={s.hederaTx} card={{ ...card, ...s, summary: "", subHires: undefined }} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function HiredRow({ card }: { card: Of<"hired"> }) {
  return (
    <section
      aria-label={`${card.title} hired`}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-line px-4 py-3.5"
    >
      <span
        aria-hidden
        className="flex size-[30px] items-center justify-center rounded-full bg-ok-soft text-ok"
      >
        <CheckIcon size={16} />
      </span>
      <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <span className="text-sm font-semibold">
          {card.title} did the {card.skill} job
        </span>
        {card.summary && <span className="text-xs text-muted">{card.summary}</span>}
      </span>
      <span className="flex flex-col items-end gap-0.5 text-xs">
        <a
          className="font-mono text-teal"
          href={`https://hashscan.io/testnet/transaction/${card.hederaTx}`}
          target="_blank"
          rel="noreferrer"
        >
          paid {usdc(card.feeUnits)} USDC
        </a>
        <a
          className="text-teal"
          href={`https://tiramisu.explorer.arkiv.network/entity/${card.jobKey}`}
          target="_blank"
          rel="noreferrer"
        >
          job on Arkiv
        </a>
        {card.log && (
          <a
            className="text-teal"
            href={`https://hashscan.io/testnet/topic/${card.log.topic}`}
            target="_blank"
            rel="noreferrer"
          >
            public log #{card.log.seq}
          </a>
        )}
      </span>
    </section>
  );
}
