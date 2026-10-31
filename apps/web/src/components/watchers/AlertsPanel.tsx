"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";

interface Channels {
  ntfy: { topic: string; url: string } | null;
  telegram: { linked: boolean } | null;
  telegramAvailable: boolean;
}

const BUTTON =
  "flex min-h-10 items-center rounded-xl border border-line-2 bg-white px-3.5 text-sm font-semibold disabled:opacity-50";

/** Alerts outside the app: each person links their own ntfy topic and/or Telegram. */
export function AlertsPanel() {
  const [c, setC] = useState<Channels | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<Channels>("/notifications")
        .then(setC)
        .catch(() => setC(null)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };
  const telegram = () =>
    run(async () => {
      const { url } = await api<{ url: string }>("/notifications/telegram", { method: "POST" });
      window.open(url, "_blank", "noopener");
      setNote("Tap Start in Telegram, then come back: it shows as linked here.");
    });
  const test = () =>
    run(async () => {
      const { sent } = await api<{ sent: number }>("/notifications/test", { method: "POST" });
      setNote(sent ? "Sent a test alert." : "Link a channel first.");
    });

  if (!c) return null;
  return (
    <section aria-label="Get alerts" className="flex flex-col gap-3 rounded-2xl bg-side p-[18px]">
      <h2 className="text-[15px] font-bold">Get alerts on your phone</h2>
      <p className="text-sm text-ink-3">
        When something happens while you're away (a fare drops, PriceGuard rebooks, an agent
        finishes, a fee waits for your review), you also get a nudge here, with a link back.
      </p>
      <div className="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm">
        <span className="font-semibold">ntfy (free push, no account)</span>
        {c.ntfy ? (
          <>
            <span className="text-ink-3">
              Subscribe to your private topic in the ntfy app (+ → topic name) or open it in a
              browser tab. Keep the name to yourself: whoever has it can read your alerts.
            </span>
            <code className="overflow-x-auto rounded-lg bg-side px-2 py-1 font-mono text-xs">
              {c.ntfy.topic}
            </code>
            <span className="flex flex-wrap gap-2">
              <a
                className={`${BUTTON} text-teal`}
                href={c.ntfy.url}
                target="_blank"
                rel="noreferrer"
              >
                Open in a browser
              </a>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => run(() => api("/notifications/ntfy", { method: "DELETE" }))}
              >
                Remove
              </button>
            </span>
          </>
        ) : (
          <button
            type="button"
            className={`${BUTTON} self-start text-teal`}
            disabled={busy}
            onClick={() => run(() => api("/notifications/ntfy", { method: "POST" }))}
          >
            Get my private topic
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm">
        <span className="font-semibold">Telegram</span>
        {!c.telegramAvailable ? (
          <span className="text-ink-3">Not set up on this server yet.</span>
        ) : c.telegram?.linked ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ok">Linked.</span> Send /stop to the bot to stop, or
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => run(() => api("/notifications/telegram", { method: "DELETE" }))}
            >
              Remove
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={`${BUTTON} self-start text-teal`}
            disabled={busy}
            onClick={telegram}
          >
            Connect Telegram
          </button>
        )}
      </div>
      <span className="flex flex-wrap items-center gap-3">
        <button type="button" className={BUTTON} disabled={busy} onClick={test}>
          Send a test alert
        </button>
        {note && <span className="text-sm text-ink-3">{note}</span>}
      </span>
    </section>
  );
}
