"use client";

import type { Card } from "@eth/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, hashscanTx, usdc } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

type Hired = Extract<Card, { type: "hired" }>;
type Review = {
  status: "holding" | "releasing" | "released" | "disputing" | "disputed" | "refunded" | "failed";
  releaseAt: string;
  releasedTx: string | null;
  onChain: "held" | "delivered" | "disputed" | "released" | "refunded" | "none" | null;
};
type Step = { label: string; tx?: string | null; done: boolean };

const left = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const BUTTON =
  "flex min-h-9 items-center rounded-xl border border-line-2 bg-white px-3.5 text-xs font-semibold disabled:opacity-50";

/**
 * Pay on delivery, as it happens: the fee is held by the spending-limit contract, the agent marks
 * the job delivered, then it's paid out. While it's held for your review you can pay now or
 * dispute; a dispute freezes the fee until the agent refunds it (or you pay anyway). Each step
 * links its proof on Hedera.
 */
export function EscrowSteps({ card, ctx }: { card: Hired; ctx?: CardCtx }) {
  const e = card.escrow;
  const live = !!(e?.reviewUntil && ctx);
  const [r, setR] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const final = useRef(false);
  final.current =
    !!r &&
    (["released", "refunded"].includes(r.status) ||
      ["released", "refunded"].includes(r.onChain ?? ""));

  const path = e && ctx ? `/chats/${ctx.chatId}/escrows/${e.id}` : "";
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const load = () =>
      api<{ escrow: Review }>(path)
        .then((x) => !stop && setR(x.escrow))
        .catch(() => {});
    void load();
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (!final.current) void load();
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live, path]);

  if (!e) return null;
  const act = async (move: "release" | "dispute") => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      await api(`${path}/${move}`, { method: "POST" });
      setR(await api<{ escrow: Review }>(path).then((x) => x.escrow));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const name = card.title;
  const chain = r?.onChain;
  const status = chain === "refunded" ? "refunded" : chain === "released" ? "released" : r?.status;
  const secs = r ? left(r.releaseAt) : 0;
  const last: Step =
    status === "released"
      ? { label: `Paid out to ${name}`, tx: r?.releasedTx ?? e.releasedTx, done: true }
      : status === "refunded"
        ? { label: "Refunded: the fee is back on your limit", done: true }
        : status === "disputed"
          ? { label: `Disputed: waiting for ${name} to refund`, done: false }
          : status === "failed"
            ? { label: `${name} can claim it after its review window`, done: false }
            : status === "holding"
              ? { label: `Pays ${name} in ${clock(secs)} unless you dispute`, done: false }
              : status === "releasing" || status === "disputing"
                ? { label: status === "releasing" ? "Paying out…" : "Disputing…", done: false }
                : e.releasedTx || !e.releaseFailed
                  ? { label: `Paid out to ${name}`, tx: e.releasedTx, done: !!e.releasedTx }
                  : { label: `${name} can claim it after its review window`, done: false };
  const steps: Step[] = [
    { label: `${usdc(card.feeUnits)} USDC held until delivery`, tx: card.hederaTx, done: true },
    { label: `${name} marked it delivered`, tx: e.deliveredTx, done: !!e.deliveredTx },
    last,
  ];

  return (
    <div className="flex w-full flex-col gap-2 pl-[42px]">
      <ol aria-label="Pay on delivery" className="flex flex-wrap gap-x-4 gap-y-1.5">
        {steps.map((s) => (
          <li key={s.label.replace(/\d+:\d+/, "")} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className={`size-2 rounded-full ${s.done ? "bg-ok" : "border border-line-2 bg-white"}`}
            />
            {s.tx ? (
              <a className="text-teal" href={hashscanTx(s.tx)} target="_blank" rel="noreferrer">
                {s.label}
              </a>
            ) : (
              <span className={s.done ? "" : "text-muted"}>{s.label}</span>
            )}
          </li>
        ))}
      </ol>
      {live && status === "holding" && secs > 0 && !confirming && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => act("release")}
            className={`${BUTTON} text-teal`}
          >
            Looks good, pay now
          </button>
          {chain === "delivered" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className={`${BUTTON} text-bad`}
            >
              Dispute
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="flex flex-col gap-2 rounded-xl bg-bad-soft px-3 py-2.5 text-xs">
          <span>
            Dispute this job? The {usdc(card.feeUnits)} USDC stays frozen on Hedera instead of going
            to {name}, until {name} refunds it or you pay anyway.
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => act("dispute")}
              className={`${BUTTON} text-bad`}
            >
              Yes, dispute
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={BUTTON}>
              Keep it
            </button>
          </span>
        </div>
      )}
      {live && status === "disputed" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act("release")}
          className={`${BUTTON} self-start`}
        >
          {busy ? "Paying…" : `Pay ${name} anyway`}
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
