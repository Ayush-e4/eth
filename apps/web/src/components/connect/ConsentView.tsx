"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me, usdc } from "@/lib/api";
import { cancelled, withFaceId } from "@/lib/passkey";
import { CheckIcon, LogoMark, PasskeyIcon } from "../icons";

const BUDGETS = ["100000", "300000", "1000000"];

/**
 * The consent screen for a connected app: who's asking, what it may do, and how much it may
 * spend. Approving signs, with Face ID, a 7-day limit from your own wallet for this app alone.
 */
export function ConsentView() {
  const q = useSearchParams();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  const [budget, setBudget] = useState("300000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  const loadMe = useCallback(
    () =>
      api<{ user: Me }>("/me")
        .then(({ user }) => setMe(user))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401)
            router.replace(
              `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
            );
        }),
    [router],
  );
  useEffect(() => {
    void loadMe();
    api<{ name: string }>(`/oauth/clients/${encodeURIComponent(clientId)}`)
      .then((c) => setAppName(c.name))
      .catch(() => setError("This link isn't from an app that registered with AgentNet."));
  }, [clientId, loadMe]);
  // A brand-new account's wallet takes a few seconds; wait for it here.
  useEffect(() => {
    if (!me?.passkey || me.wallet?.status === "ready") return;
    const t = setInterval(loadMe, 3000);
    return () => clearInterval(t);
  }, [me, loadMe]);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await withFaceId<{ redirect: string }>(
        "/oauth/authorize",
        {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: q.get("state") ?? undefined,
          code_challenge: q.get("code_challenge") ?? "",
          code_challenge_method: q.get("code_challenge_method") ?? "",
          budgetUnits: budget,
        },
        "/oauth/authorize/approve",
      );
      window.location.assign(redirect);
    } catch (err) {
      setBusy(false);
      setError(
        cancelled(err)
          ? "The Face ID prompt was closed. Try again when you're ready."
          : err instanceof ApiError
            ? err.message
            : "Couldn't connect. Try again.",
      );
    }
  };
  const deny = () => {
    try {
      const u = new URL(redirectUri);
      u.searchParams.set("error", "access_denied");
      const state = q.get("state");
      if (state) u.searchParams.set("state", state);
      window.location.assign(u.toString());
    } catch {
      router.replace("/chat");
    }
  };

  const ready = me?.wallet?.status === "ready";
  const name = appName ?? "An app";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col justify-center gap-6 px-5 py-10">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-[10px] bg-teal text-white">
          <LogoMark size={20} />
        </span>
        <span className="text-lg font-bold">AgentNet</span>
      </div>
      <h1 className="text-[26px] leading-tight font-bold tracking-tight">
        {name} wants to hire agents for you
      </h1>
      <ul className="flex flex-col gap-3 text-[15px] leading-relaxed text-ink-3">
        {[
          "It can find agents on the AgentNet market, get quotes and hire them.",
          "It pays their fees from your own wallet, only up to the limit below, for 7 days.",
          "Every hire shows up in AgentNet (and on Telegram, if linked). Cancel it any time from your Wallet.",
        ].map((t) => (
          <li key={t} className="flex gap-2.5">
            <CheckIcon size={18} className="mt-0.5 flex-none text-ok" /> {t}
          </li>
        ))}
      </ul>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Its limit</legend>
        <div className="flex flex-wrap gap-2">
          {BUDGETS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={budget === b}
              onClick={() => setBudget(b)}
              className={`h-10 rounded-full border px-4 font-mono text-sm ${budget === b ? "border-teal bg-teal-tint font-semibold text-teal-dark" : "border-line-2 bg-white"}`}
            >
              {usdc(b)} USDC
            </button>
          ))}
        </div>
      </fieldset>
      {me && !me.passkey ? (
        <p className="rounded-xl bg-side px-4 py-3 text-sm text-ink-3">
          Connecting apps needs an account made with a passkey, so the app's limit comes from your
          own wallet. Sign out and choose "Create an account with a passkey".
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={approve}
            disabled={busy || !ready || !appName}
            className="flex min-h-[52px] items-center justify-center gap-2 rounded-xl bg-teal px-5 text-[15px] font-semibold text-white disabled:opacity-60"
          >
            <PasskeyIcon size={20} />
            {busy
              ? "Waiting for Face ID…"
              : ready
                ? "Approve with Face ID"
                : "Setting up your wallet…"}
          </button>
          <button
            type="button"
            onClick={deny}
            disabled={busy}
            className="h-12 rounded-xl border border-line-2 bg-white text-[15px] font-semibold"
          >
            Don't allow
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
      <p className="text-xs text-muted">
        Hedera testnet and sandbox bookings only: test money, nothing real is bought.
      </p>
    </main>
  );
}
