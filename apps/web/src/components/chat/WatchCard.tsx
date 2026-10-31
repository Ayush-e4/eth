"use client";

import type { Card } from "@eth/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

type Check = { at: string; price: number; flight: string; simulated?: boolean };
interface Watch {
  input: {
    origin: string;
    destination: string;
    date: string;
    targetInr?: number;
    autoBook?: boolean;
  };
  until: string;
  status: "watching" | "ended" | "stopped";
  baseline: Check;
  lowest: Check;
  checks: Check[];
  alerts: (Check & { was: number; reason: string })[];
  booked?: boolean;
  canSimulate?: boolean;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const BUTTON =
  "flex min-h-9 items-center rounded-xl border border-line-2 bg-white px-3.5 text-xs font-semibold disabled:opacity-50";

/** A fare FareWatch is watching: its checks and alerts, live, with check now and stop. */
export function WatchCard({ card, ctx }: { card: Extract<Card, { type: "watch" }>; ctx: CardCtx }) {
  const [w, setW] = useState<Watch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/chats/${ctx.chatId}/watches/${card.watchId}`;
  const load = useCallback(
    () =>
      api<{ watch: Watch }>(path)
        .then((r) => setW(r.watch))
        .catch(() => {}),
    [path],
  );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: "stop" | "check-now" | "simulate") => {
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

  if (!w) return null;
  const last = w.checks.at(-1) ?? w.baseline;
  const live = w.status === "watching" && !w.booked;
  return (
    <section
      aria-label={`${card.title} watching a fare`}
      className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold">
          {card.title}: {w.input.origin}→{w.input.destination}, {w.input.date}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${live ? "bg-teal-soft text-teal" : "bg-side text-ink-3"}`}
        >
          {w.booked ? "booked" : live ? "watching" : w.status}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {[
          ["Now", `${inr(last.price)}${last.simulated ? " (simulated)" : ""}`],
          ["Lowest seen", `${inr(w.lowest.price)}${w.lowest.simulated ? " (simulated)" : ""}`],
          ["Started at", inr(w.baseline.price)],
          [
            w.input.targetInr ? "Your target" : "Checks",
            w.input.targetInr ? inr(w.input.targetInr) : String(w.checks.length),
          ],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">
        Last checked {ago(last.at)} · {w.checks.length} checks · until{" "}
        {new Date(w.until).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        {w.input.autoBook && w.input.targetInr ? " · books it at your target" : ""}
      </p>
      {w.alerts.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {w.alerts.map((a) => (
            <li key={a.at} className="text-ok">
              {inr(a.price)}, {a.reason}
              {a.simulated ? " · SIMULATED (sandbox demo)" : ""}
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
          {w.canSimulate && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("simulate")}
              className={BUTTON}
            >
              Simulate a 10% drop (sandbox)
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
