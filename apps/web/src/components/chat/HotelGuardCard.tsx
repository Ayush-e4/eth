"use client";

import type { Card } from "@eth/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

interface Guard {
  input: { hotel?: string; checkin?: string; checkout?: string };
  bookingId: string;
  status: "watching" | "stopped";
  limits: { minSavingInr: number; minSavingPercent: number; until: string };
  checks: {
    at: string;
    paid: number;
    best: number | null;
    currency: string;
    saving: number;
    simulated?: boolean;
    outcome: string;
  }[];
  invoices: { key: string; units: string; saving: number; currency: string; paid: boolean }[];
}

const money = (n: number | null, c: string) =>
  n === null ? "—" : `${Math.round(n).toLocaleString("en-IN")} ${c}`;
const BUTTON =
  "flex min-h-9 items-center rounded-xl border border-line-2 bg-white px-3.5 text-xs font-semibold disabled:opacity-50";

/** PriceGuard watching a hotel booking: its limits, its checks and rebooks, live. */
export function HotelGuardCard({
  card,
  ctx,
}: {
  card: Extract<Card, { type: "watch" }>;
  ctx: CardCtx;
}) {
  const [g, setG] = useState<Guard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/chats/${ctx.chatId}/watches/${card.watchId}`;
  const load = useCallback(
    () =>
      api<{ watch: Guard }>(path)
        .then((r) => setG(r.watch))
        .catch(() => {}),
    [path],
  );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (action: "stop" | "check-now") => {
    setBusy(true);
    setError(null);
    try {
      await api(`${path}/${action}`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (!g) return null;
  const last = g.checks.at(-1);
  const live = g.status === "watching";
  return (
    <section
      aria-label="PriceGuard watching a hotel"
      className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold">
          PriceGuard: {g.input.hotel ?? "your hotel"}
          {g.input.checkin ? `, ${g.input.checkin}→${g.input.checkout}` : ""}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${live ? "bg-teal-soft text-teal" : "bg-side text-ink-3"}`}
        >
          {g.status}
        </span>
      </div>
      <p className="text-sm text-ink-3">
        Rebooks the same stay if it gets at least ₹{g.limits.minSavingInr.toLocaleString("en-IN")}{" "}
        and {g.limits.minSavingPercent}% cheaper, while it's free to cancel, until {g.limits.until}.
        Fee: 20% of what it saves, paid only if you agree.
      </p>
      {last && (
        <p className="text-xs text-muted">
          Last check{" "}
          {new Date(last.at).toLocaleString("en-IN", { timeStyle: "short", dateStyle: "medium" })}:
          paid {money(last.paid, last.currency)}, best now {money(last.best, last.currency)}
          {last.simulated ? " (SIMULATED, sandbox)" : ""} · {last.outcome} · {g.checks.length}{" "}
          checks
        </p>
      )}
      {g.invoices.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {g.invoices.map((i) => (
            <li key={i.key} className="text-ok">
              Saved {money(i.saving, i.currency)} · fee {(Number(i.units) / 1e6).toFixed(2)} USDC ·{" "}
              {i.paid ? "paid" : "not paid yet"}
            </li>
          ))}
        </ul>
      )}
      {live && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => act("check-now")}
            className={`${BUTTON} text-teal`}
          >
            Check now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("stop")}
            className={`${BUTTON} text-bad`}
          >
            Stop watching
          </button>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
