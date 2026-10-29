"use client";

import type { ChatMode } from "@eth/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Me, shortAddress, usdc } from "@/lib/api";
import { useSession } from "@/lib/session";
import { CheckIcon, LogoMark } from "../icons";

const STEPS = [
  { title: "About you", hint: "Name and home city" },
  { title: "Spending", hint: "Auto or ask every time" },
  { title: "Test money", hint: "Free USDC on testnet" },
];
const LIMITS = ["100000", "300000", "1000000"];
const input = "h-[46px] rounded-[10px] border border-line-2 bg-white px-3.5 text-[15px]";

export function Setup() {
  const router = useRouter();
  const { me, setMe } = useSession();
  const [at, setAt] = useState(0);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState<ChatMode>("auto");
  const [limit, setLimit] = useState("300000");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setName(me.displayName === "Demo" ? "" : (me.displayName ?? ""));
    setCity(me.homeCity ?? "");
    setMode(me.defaultMode);
    setLimit(me.defaultLimitUnits);
  }, [me]);

  const save = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      setMe((await api<{ user: Me }>("/me", { method: "PATCH", body })).user);
      return true;
    } catch {
      setError("Couldn't save that. Check the fields and try again.");
      return false;
    }
  };

  const next = async () => {
    const ok =
      at === 0
        ? await save({ displayName: name.trim() || null, homeCity: city.trim() || null })
        : at === 1
          ? await save({ defaultMode: mode, defaultLimitUnits: limit })
          : await save({ onboarded: true });
    if (!ok) return;
    if (at < 2) setAt(at + 1);
    else router.replace("/chat");
  };

  return (
    <div className="flex min-h-dvh flex-col bg-side">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-white px-8 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-teal text-white">
            <LogoMark />
          </span>
          <span className="text-lg font-bold">AgentNet</span>
        </div>
        <span className="flex items-center gap-2 font-mono text-[13px] text-ink-3">
          <span aria-hidden className="size-2 rounded-full bg-ok" />
          {me?.address ? `${shortAddress(me.address)} · Hedera testnet` : "Demo account"}
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-wrap items-start gap-8 px-6 pt-10 pb-16">
        <nav aria-label="Setup steps" className="flex flex-[1_1_240px] flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-teal">Welcome</span>
            <span className="text-[22px] font-bold">Let's get you set up</span>
            <span className="text-sm leading-relaxed text-ink-3">
              Three quick steps. You can change any of this later.
            </span>
          </div>
          <ol className="flex flex-col gap-1.5">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                aria-current={i === at ? "step" : undefined}
                className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${i === at ? "border-teal bg-white" : "border-line"}`}
              >
                <span
                  aria-hidden
                  className={`flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-bold ${i < at ? "bg-teal text-white" : "border border-line-2 bg-white text-ink-3"}`}
                >
                  {i < at ? <CheckIcon size={14} /> : i + 1}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold">{s.title}</span>
                  <span className="text-xs text-muted">{s.hint}</span>
                </span>
              </li>
            ))}
          </ol>
        </nav>

        <section
          aria-label={STEPS[at]?.title}
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-7 rounded-[20px] border border-line bg-white p-8"
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-muted">Step {at + 1} of 3</span>
            <h1 className="text-[26px] font-bold">
              {["About you", "How should agents spend for you?", "Get free test money"][at]}
            </h1>
          </div>

          {at === 0 && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
              <label className="flex flex-col gap-2 text-sm font-semibold">
                What should we call you?
                <input
                  className={input}
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="given-name"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-semibold">
                Home city
                <input
                  className={input}
                  value={city}
                  maxLength={60}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Mumbai"
                />
                <span className="text-xs font-normal text-muted">
                  Trips start here unless you say otherwise.
                </span>
              </label>
            </div>
          )}

          {at === 1 && (
            <div className="flex flex-col gap-5">
              <p className="text-[15px] leading-relaxed text-ink-3">
                Agents charge small fees in USDC. Each new chat starts with these settings, and you
                can change them per chat.
              </p>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
                {(
                  [
                    [
                      "auto",
                      "Auto, up to a limit",
                      "The concierge hires and pays agents on its own while it stays inside your limit.",
                    ],
                    [
                      "ask",
                      "Ask me every time",
                      "You approve each payment before anything happens.",
                    ],
                  ] as const
                ).map(([id, title, body]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={mode === id}
                    onClick={() => setMode(id)}
                    className={`flex flex-col gap-2 rounded-[14px] border-2 p-[18px] text-left ${mode === id ? "border-teal bg-teal-tint" : "border-line"}`}
                  >
                    <span className="text-base font-bold">{title}</span>
                    <span className="text-sm leading-relaxed text-ink-3">{body}</span>
                  </button>
                ))}
              </div>
              <label className="flex max-w-xs flex-col gap-2 text-sm font-semibold">
                Per chat, up to
                <select
                  className={`${input} font-mono`}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                >
                  {(LIMITS.includes(limit) ? LIMITS : [limit, ...LIMITS]).map((u) => (
                    <option key={u} value={u}>
                      {usdc(u)} USDC
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {at === 2 && (
            <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-ink-3">
              <p>You're on Hedera testnet, so money here is free and only works here.</p>
              <ul className="flex flex-col gap-2 pl-5 list-disc">
                <li>
                  Test USDC:{" "}
                  <a
                    className="font-medium text-teal"
                    href="https://faucet.circle.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Circle faucet
                  </a>{" "}
                  (pick Hedera testnet)
                </li>
                <li>
                  Test HBAR for network fees:{" "}
                  <a
                    className="font-medium text-teal"
                    href="https://portal.hedera.com/faucet"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Hedera faucet
                  </a>
                </li>
              </ul>
              <p className="rounded-xl bg-side px-4 py-3 text-sm">
                Saving your spending limit on Hedera (MetaMask asks once) comes with the next
                update. Until then the concierge shows you agents but doesn't pay anyone.
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-3 border-t border-line pt-6">
            <button
              type="button"
              disabled={at === 0}
              onClick={() => setAt(at - 1)}
              className="h-[46px] rounded-[10px] border border-line-2 bg-white px-[18px] text-sm font-semibold disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={next}
              className="h-[46px] rounded-[10px] bg-teal px-[22px] text-sm font-semibold text-white hover:bg-teal-dark"
            >
              {at < 2 ? "Continue" : "Start chatting"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
