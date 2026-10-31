"use client";

import type { Card } from "@eth/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, hashscanSchedule, usdc } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

type PaymentCardData = Extract<Card, { type: "payment" }>;
type Status = "scheduled" | "executed" | "cancelled" | "failed";

const left = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));

const LABEL: Record<Status, string> = {
  scheduled: "pending",
  executed: "paid",
  cancelled: "cancelled · nothing paid",
  failed: "didn't go through · nothing paid",
};

/** A payment sitting in its undo window on Hedera: counts down, and can be cancelled until it runs. */
export function PaymentCard({ card, ctx }: { card: PaymentCardData; ctx: CardCtx }) {
  const [status, setStatus] = useState<Status>("scheduled");
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [unknown, setUnknown] = useState(false); // the server no longer tracks it (e.g. restarted)
  const [, tick] = useState(0);
  const doneRef = useRef(false);
  doneRef.current = status !== "scheduled" || unknown;

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<{ payment: { status: Status } }>(`/chats/${ctx.chatId}/payments/${card.scheduleId}`)
        .then((r) => !stop && setStatus(r.payment.status))
        .catch((err) => {
          if (!stop && err instanceof ApiError && [404, 503].includes(err.status)) setUnknown(true);
        });
    void load();
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (!doneRef.current) void load();
    }, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [card.scheduleId, ctx.chatId]);

  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await api(`/chats/${ctx.chatId}/payments/${card.scheduleId}/cancel`, { method: "POST" });
      setStatus("cancelled");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const secs = left(card.executesAt);
  const open = status === "scheduled" && secs > 0 && !unknown;
  return (
    <section
      aria-label={`Payment to ${card.title}`}
      className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold">
          {usdc(card.feeUnits)} USDC to {card.title}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            status === "executed"
              ? "bg-ok-soft text-ok"
              : status === "scheduled"
                ? "bg-saffron-soft text-saffron-ink"
                : "bg-bad-soft text-bad"
          }`}
        >
          {open
            ? `pays in ${secs}s`
            : unknown
              ? "see Hedera for the outcome"
              : status === "scheduled"
                ? "paying…"
                : LABEL[status]}
        </span>
      </div>
      <p className="text-xs text-muted">
        Scheduled on{" "}
        <a
          className="text-teal"
          href={hashscanSchedule(card.scheduleId)}
          target="_blank"
          rel="noreferrer"
        >
          Hedera
        </a>{" "}
        with an undo window. Until it runs you can cancel, and then nothing is paid and the job
        isn't done.
      </p>
      {open && (
        <button
          type="button"
          disabled={cancelling || ctx.isDemo}
          onClick={cancel}
          className="flex min-h-10 items-center justify-center self-start rounded-xl border border-line-2 bg-white px-4 text-sm font-semibold text-bad disabled:opacity-50"
        >
          {cancelling ? "Cancelling…" : "Cancel payment"}
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
