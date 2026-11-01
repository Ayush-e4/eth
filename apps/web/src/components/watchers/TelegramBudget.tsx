"use client";

import type { Card } from "@eth/shared";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, usdc } from "@/lib/api";
import { cancelled, withFaceId } from "@/lib/passkey";
import { useSession } from "@/lib/session";
import { sendMessage } from "@/lib/stream";

interface Budget {
  linked: boolean;
  budget: { budgetUnits: string; remainingUnits: string | null; expiresAt: string } | null;
}
const CHOICES = ["100000", "300000", "1000000"];

/**
 * The Telegram budget: approved once here with Face ID, then hires in the Telegram chat spend
 * from it for 7 days, no trip to a browser each time. Arriving from the bot's button
 * (?telegram=budget), approving also tells the concierge to carry on, in Telegram.
 */
export function TelegramBudget() {
  const { me } = useSession();
  const fromBot = useSearchParams().get("telegram") === "budget";
  const box = useRef<HTMLDivElement>(null);
  const [b, setB] = useState<Budget | null>(null);
  const [pick, setPick] = useState("300000");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<Budget>("/notifications/telegram/budget")
        .then(setB)
        .catch(() => setB(null)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (fromBot && b) box.current?.scrollIntoView({ block: "center" });
  }, [fromBot, b]);

  if (!b?.linked) return null;
  const approve = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { chatId, card } = await api<{
        chatId: string;
        card: Extract<Card, { type: "limit" }>;
      }>("/notifications/telegram/budget", { method: "POST", body: { budgetUnits: pick } });
      const path = `/chats/${chatId}/mandate`;
      await withFaceId(`${path}/face-id`, { card }, path, { card });
      await load();
      if (fromBot) {
        // The bot was waiting on this: let the concierge carry on; its reply goes to Telegram.
        for await (const e of sendMessage(chatId, "I've approved my Telegram budget. Go ahead."))
          if (e.type === "done" || e.type === "error") break;
        setNote("Approved. Go back to Telegram: the concierge is carrying on there.");
      } else setNote("Approved. Hires in Telegram now spend from this budget.");
    } catch (err) {
      setNote(
        cancelled(err)
          ? "The Face ID prompt was closed."
          : err instanceof ApiError
            ? err.message
            : "Couldn't set the budget. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const live = b.budget && new Date(b.budget.expiresAt).getTime() > Date.now();
  return (
    <div
      ref={box}
      className={`flex flex-col gap-2 rounded-xl border p-3 ${fromBot ? "border-teal bg-teal-tint" : "border-line"}`}
    >
      <span className="font-semibold">Telegram budget</span>
      {live && b.budget ? (
        <span className="text-ink-3">
          Hires in Telegram can spend{" "}
          <strong className="font-mono">
            {usdc(b.budget.remainingUnits ?? b.budget.budgetUnits)}
          </strong>{" "}
          more USDC, until{" "}
          {new Date(b.budget.expiresAt).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
          })}
          .
        </span>
      ) : (
        <span className="text-ink-3">
          Approve once and the concierge can hire agents for you right in Telegram, from your own
          wallet, up to this much for 7 days.
        </span>
      )}
      {me?.wallet?.status === "ready" ? (
        <span className="flex flex-wrap items-center gap-2">
          {CHOICES.map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={pick === u}
              onClick={() => setPick(u)}
              className={`h-9 rounded-full border px-3 font-mono text-[13px] ${pick === u ? "border-teal bg-white font-semibold text-teal-dark" : "border-line-2 bg-white"}`}
            >
              {usdc(u)}
            </button>
          ))}
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="flex h-9 items-center rounded-[10px] bg-teal px-3.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Waiting for Face ID…" : live ? "Set a new budget" : "Approve with Face ID"}
          </button>
        </span>
      ) : (
        <span className="text-xs text-muted">
          Needs an account made with a passkey (its Face ID wallet pays).
        </span>
      )}
      {note && <span className="text-sm text-ink-2">{note}</span>}
    </div>
  );
}
