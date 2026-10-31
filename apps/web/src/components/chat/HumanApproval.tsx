"use client";

import type { Card } from "@eth/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CardCtx } from "./MoneyCards";

type Approval = Extract<Card, { type: "approval" }>;

interface Check {
  id: string;
  status: "waiting" | "verified" | "denied" | "expired" | "failed" | "mismatch";
  reason?: string;
  userCode: string;
  link: string;
  expiresAt: string;
}

const NOT_PAID: Record<string, string> = {
  denied: "You declined in World ID.",
  expired: "The World ID check timed out.",
  failed: "World ID couldn't confirm it.",
  mismatch: "That isn't the World ID linked to your account.",
};

const btn =
  "flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-50";

/**
 * Approve, with a human check first: the server asks World ID to confirm a real, present person
 * (the one linked to this account), and only its verdict unlocks the payment. Cancelling,
 * declining in World ID or letting it time out leaves the agent unpaid.
 */
export function HumanApproval({ card, ctx }: { card: Approval; ctx: CardCtx }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Ask the server how the check is going; it decides, the browser only shows it.
  useEffect(() => {
    if (check?.status !== "waiting") return;
    const t = setInterval(() => {
      api<{ check: Check }>(`/human-checks/${check.id}`)
        .then(({ check: next }) => {
          setCheck(next);
          if (next.status === "verified") ctx.onReply(`Approve ${card.code}`);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [check, card.code, ctx]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { check: c } = await api<{ check: Check }>(
        `/chats/${ctx.chatId}/approvals/${card.code}/human-check`,
        { method: "POST" },
      );
      setCheck(c); // the person opens the link themselves: no pop-up to block
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the World ID check.");
    } finally {
      setStarting(false);
    }
  }

  if (check?.status === "waiting")
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-warm-line bg-white p-3 text-sm">
        <span className="font-semibold">Confirm it's you in World ID</span>
        <span className="text-[#5C3A00]">
          Approve the request in the World ID app. Code{" "}
          <strong className="font-mono">{check.userCode}</strong>
        </span>
        <div className="flex flex-wrap gap-2">
          <a
            href={check.link}
            target="_blank"
            rel="noreferrer"
            className={`${btn} bg-teal text-white`}
          >
            Open World ID
          </a>
          <button
            type="button"
            onClick={() => setCheck(null)}
            className={`${btn} border border-line-2 bg-white`}
          >
            Cancel
          </button>
        </div>
        <span className="text-xs text-muted">
          Waiting for World ID… nothing is paid until it confirms.
        </span>
      </div>
    );

  if (check?.status === "verified")
    return <p className="text-sm font-semibold text-ok">Verified with World ID. Paying…</p>;

  const failed = check ? (NOT_PAID[check.status] ?? check.reason) : null;
  return (
    <div className="flex flex-col gap-2">
      {(failed || error) && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">
          {error ?? `${failed} Nothing was paid.`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={ctx.busy || starting}
          onClick={start}
          className={`${btn} bg-teal text-white`}
        >
          {starting ? "Starting…" : failed ? "Try World ID again" : "Approve with World ID"}
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
    </div>
  );
}
