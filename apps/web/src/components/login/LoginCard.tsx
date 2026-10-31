"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api, type Me, shortAddress } from "@/lib/api";
import {
  connect,
  hasWallet,
  onHederaTestnet,
  signIn,
  signInMessage,
  switchToHedera,
  type WalletStep,
} from "@/lib/wallet";
import { CheckIcon, InfoIcon, WalletIcon } from "../icons";
import { PasskeyChoice } from "./PasskeyChoice";

const STEPS = ["Connect", "Network", "Sign"] as const;
const stepIndex: Record<WalletStep, number> = { connect: 0, "no-wallet": 0, network: 1, sign: 2 };

const primary =
  "flex h-[52px] w-full items-center justify-center gap-2.5 rounded-xl bg-teal px-5 text-[15px] font-semibold text-white hover:bg-teal-dark disabled:opacity-60";
const secondary =
  "flex h-12 w-full items-center justify-center rounded-xl border border-line-2 bg-white text-[15px] font-semibold";

export function LoginCard() {
  const router = useRouter();
  const [step, setStep] = useState<WalletStep>("connect");
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const done = (me: Me) => {
    const next = new URLSearchParams(window.location.search).get("next");
    router.replace(!me.onboarded ? "/welcome" : next?.startsWith("/") ? next : "/chat");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const code = (err as { code?: number }).code;
      setError(
        code === 4001
          ? "You cancelled in MetaMask. Try again when you're ready."
          : err instanceof ApiError
            ? `Sign-in failed: ${err.message}`
            : "Something went wrong with MetaMask. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const sign = (addr: `0x${string}`) =>
    run(async () => {
      setStep("sign");
      setPreview(
        signInMessage(addr, "…").replace(/Nonce: .*/, "Nonce: (one-time code from the server)"),
      );
      done(await signIn(addr));
    });

  const start = () => {
    if (!hasWallet()) return setStep("no-wallet");
    return run(async () => {
      const addr = await connect();
      setAddress(addr);
      if (!(await onHederaTestnet())) return setStep("network");
      await sign(addr);
    });
  };

  const switchNet = () =>
    run(async () => {
      await switchToHedera();
      if (address) await sign(address);
    });

  const demo = () =>
    run(async () => done((await api<{ user: Me }>("/auth/demo", { method: "POST" })).user));

  const at = stepIndex[step];
  return (
    <div className="flex w-full max-w-[440px] flex-col gap-7">
      {step !== "connect" && (
        <ol aria-label="MetaMask sign-in steps" className="flex items-center gap-2.5">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-2.5">
              <span
                aria-current={i === at ? "step" : undefined}
                className={`flex size-[26px] flex-none items-center justify-center rounded-full text-xs font-bold ${
                  i < at
                    ? "bg-teal text-white"
                    : i === at
                      ? "border-2 border-teal text-teal"
                      : "border border-line-2 text-muted"
                }`}
              >
                {i < at ? <CheckIcon size={14} /> : i + 1}
              </span>
              <span className={`text-[13px] ${i <= at ? "font-semibold" : "text-muted"}`}>
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="h-px min-w-4 flex-1 bg-line-2" />
              )}
            </li>
          ))}
        </ol>
      )}

      {step === "connect" && (
        <div className="flex flex-col gap-6">
          <Heading
            title="Sign in to AgentNet"
            body="No password and no app to install: your passkey is your login."
          />
          <PasskeyChoice onDone={done} />
          <div className="flex items-center gap-3 text-xs text-muted">
            <span aria-hidden className="h-px flex-1 bg-line-2" /> or use your own wallet
            <span aria-hidden className="h-px flex-1 bg-line-2" />
          </div>
          <div className="flex flex-col gap-3">
            <button type="button" className={secondary} onClick={start} disabled={busy}>
              <WalletIcon size={20} /> <span className="ml-2">Connect MetaMask</span>
            </button>
            <button
              type="button"
              onClick={demo}
              disabled={busy}
              className="self-center text-sm font-medium text-teal"
            >
              Just looking? Try it without an account
            </button>
          </div>
        </div>
      )}

      {step === "no-wallet" && (
        <div className="flex flex-col gap-6">
          <Heading
            title="MetaMask isn't installed"
            body="AgentNet uses MetaMask to sign you in and approve spending limits. Install it, then come back to this tab."
          />
          <p
            role="note"
            className="flex gap-3 rounded-xl bg-saffron-soft px-4 py-3.5 text-sm leading-relaxed text-[#5C3A00]"
          >
            <InfoIcon className="mt-0.5 flex-none text-saffron-ink" /> No wallet yet? The demo lets
            you try everything first.
          </p>
          <div className="flex flex-col gap-3">
            <a
              className={primary}
              href="https://metamask.io/download/"
              target="_blank"
              rel="noreferrer"
            >
              Install MetaMask
            </a>
            <button type="button" className={secondary} onClick={() => setStep("connect")}>
              I've installed it, check again
            </button>
            <button
              type="button"
              onClick={demo}
              className="self-center text-sm font-medium text-teal"
            >
              Try the demo instead
            </button>
          </div>
        </div>
      )}

      {step === "network" && (
        <div className="flex flex-col gap-6">
          <Heading
            title="Switch to Hedera testnet"
            body="MetaMask is connected, but to a different network. AgentNet runs on Hedera testnet, where everything uses free test money."
          />
          {address && (
            <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3.5">
              <span className="flex-1 font-mono text-sm">{shortAddress(address)}</span>
              <span className="rounded-full bg-ok-soft px-2.5 py-1 text-xs font-semibold text-ok">
                Connected
              </span>
            </div>
          )}
          <button type="button" className={primary} onClick={switchNet} disabled={busy}>
            Switch network
          </button>
          <p className="text-center text-[13px] text-muted">
            If you don't have Hedera testnet yet, MetaMask will ask to add it (chain 296).
          </p>
        </div>
      )}

      {step === "sign" && (
        <div className="flex flex-col gap-6">
          <Heading
            title="Confirm it's you"
            body="MetaMask shows this message. Signing proves the account is yours. It's free and moves no money."
          />
          {preview && (
            <pre
              title="Message you will sign"
              className="whitespace-pre-wrap rounded-xl border border-line bg-side p-4 font-mono text-[12.5px] leading-relaxed"
            >
              {preview}
            </pre>
          )}
          {busy ? (
            <p className="flex items-center gap-2.5 text-sm text-ink-3">
              <span
                aria-hidden
                className="size-4 animate-spin rounded-full border-2 border-line-2 border-t-teal"
              />{" "}
              Waiting for your signature in MetaMask
            </p>
          ) : (
            address && (
              <button type="button" className={primary} onClick={() => sign(address)}>
                Open MetaMask to sign
              </button>
            )
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-5 text-[13px] leading-relaxed text-ink-3">
        <p>
          You only need to sign in to chat and hire agents. Signing in is free and never moves
          money.
        </p>
      </div>
    </div>
  );
}

function Heading({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[26px] leading-tight font-bold tracking-tight sm:text-[30px]">{title}</h1>
      <p className="text-[15px] leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}
