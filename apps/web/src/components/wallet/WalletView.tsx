"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  hashscanTopic,
  hashscanTx,
  type Limit,
  shortAddress,
  usdc,
  type WalletInfo,
  when,
} from "@/lib/api";
import { cancelled, withFaceId } from "@/lib/passkey";
import { revokeInWallet } from "@/lib/wallet";
import { DemoAllowance } from "./DemoAllowance";

const STATUS: Record<Limit["status"], string> = {
  active: "bg-ok-soft text-ok",
  expired: "bg-bubble text-ink-3",
  revoked: "bg-bad-soft text-bad",
};

export function WalletView() {
  const [w, setW] = useState<WalletInfo | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<WalletInfo>("/wallet")
      .then(setW)
      .catch(() => setError("Couldn't load your wallet."));
  }, []);
  useEffect(load, [load]);

  const cancel = async (l: Limit) => {
    setCancelling(l.id);
    setError(null);
    try {
      const path = `/wallet/limits/${l.id}/revoke`;
      if (l.via === "face-id") await withFaceId(`${path}/face-id`, {}, path);
      else if (l.demo) await api(path, { method: "POST" });
      else await revokeInWallet(l.registry, l.mandateId);
      load();
    } catch (err) {
      const code = (err as { code?: number }).code;
      setError(
        cancelled(err)
          ? "The Face ID prompt was closed."
          : code === 4001
            ? "You cancelled in MetaMask."
            : err instanceof ApiError
              ? err.message
              : "Couldn't cancel the limit.",
      );
    } finally {
      setCancelling(null);
    }
  };

  if (!w) return <p className="p-10 text-center text-muted">{error ?? "Loading your wallet…"}</p>;
  const usdcLeft = w.balances ? usdc(w.balances.usdcUnits) : "—";
  const hbar = w.balances ? (Number(w.balances.hbarTinybars) / 1e8).toFixed(2) : "—";

  return (
    <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 pt-8 pb-14 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="text-[32px] font-bold tracking-tight">Wallet</h1>
          <p className="text-[15px] leading-relaxed text-ink-3">
            Your money stays in your own Hedera account. Agents are only paid through limits you
            approved, and you can cancel any limit at once. Every limit and payment is also written
            to a{" "}
            <Link href="/log" className="text-teal underline-offset-2 hover:underline">
              public spending log
            </Link>{" "}
            on Hedera that nobody can edit.
          </p>
        </div>
        <a
          href="https://faucet.circle.com/"
          target="_blank"
          rel="noreferrer"
          className="flex h-11 items-center rounded-xl border border-line-2 bg-white px-4 text-sm font-semibold"
        >
          Get test USDC
        </a>
      </div>

      <section
        aria-label="Account"
        className="flex flex-wrap items-center gap-4 rounded-[18px] bg-teal px-5 py-[18px] text-white"
      >
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
          <span className="font-mono text-base">
            {w.shared
              ? "Shared demo wallet"
              : w.address
                ? `${w.faceId ? "Face ID wallet · " : ""}${shortAddress(w.address)}`
                : "No wallet"}
          </span>
          <span className="text-[13px] text-[#BFDCDF]">
            {w.account ? (
              <>
                Hedera account{" "}
                <a
                  className="font-mono text-white underline"
                  href={`https://hashscan.io/testnet/account/${w.account}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {w.account}
                </a>{" "}
                · Hedera testnet
              </>
            ) : (
              "No Hedera account yet. Get test HBAR to create one."
            )}
          </span>
        </div>
        <dl className="flex flex-wrap gap-7">
          {[
            ["USDC", usdcLeft],
            w.faceId ? ["Network fees", "on us"] : ["HBAR, for network fees", hbar],
            ["Agent fees paid", usdc(w.spentUnits)],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-xs text-[#BFDCDF]">{k}</dt>
              <dd className="text-2xl font-bold">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {w.faceId && (
        <p className="rounded-xl bg-side px-4 py-3 text-sm leading-relaxed text-ink-3">
          {w.faceId.status === "ready"
            ? "This wallet is a contract on Hedera whose only key is your passkey: limits and cancels need your Face ID or fingerprint, and nobody else (AgentNet included) can move its money. We pay its network fees."
            : w.faceId.status === "creating"
              ? "Setting up your wallet on Hedera. This takes a few seconds."
              : "Setting up your wallet didn't work. Reload this page to try again."}
          {w.faceId.giftUnits &&
            ` We sent it ${usdc(w.faceId.giftUnits)} test USDC to start you off.`}
        </p>
      )}
      {w.shared && <DemoAllowance />}
      {w.shared && (
        <p className="-mt-3 text-[13px] text-ink-3">
          You're in demo mode: everyone trying the demo shares this test wallet, so its balance
          moves with their bookings too.
        </p>
      )}

      <section aria-labelledby="limits" className="flex flex-col gap-3.5">
        <h2 id="limits" className="text-lg font-bold">
          Spending limits
        </h2>
        <p className="text-sm leading-relaxed text-ink-3">
          Each chat that hires agents gets its own limit on Hedera, naming exactly which agents it
          can pay. Cancelling one takes effect at once.
        </p>
        {error && (
          <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
            {error}
          </p>
        )}
        {w.limits.length === 0 && (
          <p className="text-sm text-muted">
            No limits yet. One is created the first time the concierge hires an agent in a chat.
          </p>
        )}
        <ul className="flex flex-col gap-2.5">
          {w.limits.map((l) => {
            const pct = l.spentUnits
              ? Math.min(100, (Number(l.spentUnits) / Number(l.budgetUnits)) * 100)
              : 0;
            return (
              <li
                key={l.id}
                className={`flex flex-wrap items-center gap-4 rounded-[14px] border border-line px-[18px] py-4 ${l.status === "active" ? "bg-white" : "bg-side"}`}
              >
                <span className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/chat/${l.chatId}`}
                      className="truncate text-[15px] font-semibold hover:underline"
                    >
                      {l.chatTitle}
                    </Link>
                    <span className="font-mono text-xs text-muted">#{l.mandateId}</span>
                    {l.retired && (
                      <span
                        className="rounded-full bg-side px-2.5 py-0.5 text-xs text-ink-3"
                        title="Made on our previous contract. New hires use a new limit."
                      >
                        older contract
                      </span>
                    )}
                    {l.logSeq !== null && w.logTopic && (
                      <a
                        className="font-mono text-xs text-teal"
                        href={hashscanTopic(w.logTopic)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        log #{l.logSeq}
                      </a>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${STATUS[l.status]}`}
                    >
                      {l.status}
                    </span>
                  </span>
                  <span className="text-[13px] text-ink-3">
                    Can pay {l.payees.join(", ")} ·{" "}
                    {l.status === "active"
                      ? `until ${when(l.expiresAt)}`
                      : `ended ${when(l.expiresAt)}`}
                  </span>
                </span>
                <span className="flex flex-[0_1_200px] flex-col gap-1.5">
                  <span className="text-right text-[13px]">
                    <span className="font-mono">
                      {l.spentUnits ? usdc(l.spentUnits) : "?"} / {usdc(l.budgetUnits)}
                    </span>{" "}
                    USDC
                  </span>
                  <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-line">
                    <span className="block h-full bg-teal" style={{ width: `${pct}%` }} />
                  </span>
                </span>
                {l.status === "active" && (
                  <button
                    type="button"
                    disabled={cancelling === l.id}
                    onClick={() => cancel(l)}
                    className="h-10 rounded-[10px] border border-[#E8B4AE] bg-white px-3.5 text-sm font-semibold text-bad disabled:opacity-50"
                  >
                    {cancelling === l.id
                      ? "Cancelling…"
                      : l.via === "face-id"
                        ? "Cancel with Face ID"
                        : l.demo
                          ? "Cancel limit"
                          : "Cancel in MetaMask"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="payments" className="flex flex-col gap-3.5">
        <h2 id="payments" className="text-lg font-bold">
          Payments
        </h2>
        {w.payments.length === 0 ? (
          <p className="text-sm text-muted">No payments yet.</p>
        ) : (
          <ul className="overflow-hidden rounded-[14px] border border-line">
            {w.payments.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-3 border-t border-[#F1EEE8] px-4 py-3 text-sm first:border-t-0"
              >
                <span className="w-32 text-ink-3">{when(p.createdAt)}</span>
                <span className="flex min-w-0 flex-[1_1_220px] flex-col">
                  <span className="font-semibold">{p.to}</span>
                  <span className="truncate text-xs text-muted">
                    {p.skill} · {p.chatTitle}
                  </span>
                </span>
                <span className="font-mono">−{usdc(p.feeUnits)}</span>
                <a
                  className="w-28 text-right font-mono text-xs text-teal"
                  href={hashscanTx(p.hederaTx)}
                  target="_blank"
                  rel="noreferrer"
                >
                  HashScan
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
