"use client";

import type { Card } from "@eth/shared";
import { useEffect, useState } from "react";
import { ApiError, api, usdc } from "@/lib/api";
import { cancelled, withFaceId } from "@/lib/passkey";
import { createMandateInWallet } from "@/lib/wallet";
import { CheckIcon, ShieldIcon } from "../icons";
import type { CardCtx } from "./MoneyCards";

const btn =
  "flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-50";

/**
 * The chat's spending limit on Hedera. Passkey users approve it with Face ID from their own
 * wallet; wallet users sign it in MetaMask (two transactions: allow USDC, then create the
 * limit); demo users approve it with the shared test wallet.
 */
export function LimitCard({ card, ctx }: { card: Extract<Card, { type: "limit" }>; ctx: CardCtx }) {
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // Reopening the chat: if a live limit already covers these agents, this card was approved.
  useEffect(() => {
    let stop = false;
    api<{ mandate: { payees: string[]; expiresAt: string } | null }>(`/chats/${ctx.chatId}/mandate`)
      .then(({ mandate: m }) => {
        const covers =
          !!m &&
          new Date(m.expiresAt).getTime() > Date.now() &&
          card.payees.every((p) => m.payees.some((a) => a.toLowerCase() === p.agent.toLowerCase()));
        if (covers && !stop) setState((s) => (s === "idle" ? "done" : s));
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [ctx.chatId, card.payees]);
  const approve = async () => {
    setState("working");
    setError(null);
    try {
      const path = `/chats/${ctx.chatId}/mandate`;
      if (ctx.faceId) await withFaceId(`${path}/face-id`, { card }, path, { card });
      else
        await api(path, {
          method: "POST",
          body: ctx.isDemo
            ? { demo: true, card }
            : { mandateId: (await createMandateInWallet(card)).toString(), card },
        });
      setState("done");
      ctx.onReply("I've approved the spending limit. Go ahead.");
    } catch (err) {
      setState("idle");
      const code = (err as { code?: number }).code;
      setError(
        cancelled(err)
          ? "The Face ID prompt was closed. Try again when you're ready."
          : code === 4001
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
        most <span className="font-mono">{usdc(card.perPaymentCapUnits)}</span> per payment,{" "}
        {card.payees.length ? (
          <>
            only to <strong>{card.payees.map((p) => p.name).join(", ")}</strong>
          </>
        ) : (
          <>to any agent on the market</>
        )}
        , until{" "}
        {new Date(card.expiresAt * 1000).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        })}
        . Hedera enforces it: nobody can spend past it.
        {ctx.faceId && " It comes from your own wallet, and only your Face ID can approve it."}
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
            ? ctx.faceId
              ? "Waiting for Face ID…"
              : ctx.isDemo
                ? "Setting it on Hedera…"
                : "Confirm in MetaMask…"
            : ctx.faceId
              ? "Approve with Face ID"
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
