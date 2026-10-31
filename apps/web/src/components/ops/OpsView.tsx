"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, hashscanTx, usdc, when } from "@/lib/api";
import { type OpsAgent, OpsAgents } from "./OpsAgents";

interface Balances {
  account: string;
  hbarTinybars?: string;
  usdcUnits?: string;
  warnings?: string[];
}
interface Ops {
  money: {
    demoWallet: Balances | null;
    demoFees: { feesTodayUnits: string; budgetUnits: string } | null;
    concierge: Balances | null;
  };
  people: Record<string, number>;
  services: { name: string; ok: boolean }[];
  agents: OpsAgent[];
  recentHires: {
    at: string;
    agent: string;
    skill: string;
    feeUnits: string;
    chatTitle: string;
    hederaTx: string;
  }[];
}

const hbar = (t?: string) => (t ? (Number(t) / 1e8).toFixed(1) : "—");
const PEOPLE: [string, string][] = [
  ["users", "Accounts"],
  ["passkey", "Passkey"],
  ["faceIdWallets", "Face ID wallets"],
  ["wallet", "MetaMask"],
  ["newToday", "New, last 24 h"],
  ["messagesToday", "Messages, 24 h"],
  ["hiresToday", "Hires, 24 h"],
];
const card = "flex flex-col gap-1.5 rounded-2xl border border-line p-4";
const link = "font-mono text-teal underline";

/** Admins' view of AgentNet. Refreshes every 30 s. */
export function OpsView() {
  const [ops, setOps] = useState<Ops | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/ops", { credentials: "same-origin" })
      .then(async (r) => {
        const body = await r.json();
        if (r.status === 403) setDenied(body.yourAccountId ?? "");
        else if (!r.ok) throw new ApiError(r.status, body.error ?? "failed");
        else {
          setOps(body as Ops);
          setError(null);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load ops."));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (denied !== null)
    return (
      <main className="mx-auto flex max-w-[640px] flex-col gap-3 px-6 pt-10">
        <h1 className="text-[32px] font-bold tracking-tight">Ops</h1>
        <p className="text-[15px] text-ink-3">
          Admins only. To make this account an admin, add its id to <code>ADMIN_USERS</code> in the
          server's <code>.env</code> and restart the API:
        </p>
        <code className="rounded-xl bg-side px-3 py-2 font-mono text-sm">{denied}</code>
      </main>
    );
  if (!ops) return <p className="p-10 text-center text-muted">{error ?? "Loading…"}</p>;
  const { demoWallet: w, demoFees: f, concierge: c } = ops.money;
  const p = ops.people;
  return (
    <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 pt-8 pb-14 sm:px-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-bold tracking-tight">Ops</h1>
        <p className="text-[15px] text-ink-3">
          Is the money there, is anyone using it, are the agents up. Admins only.
        </p>
      </div>

      <section aria-label="Money" className="grid gap-3 sm:grid-cols-3">
        <div className={card}>
          <span className="text-[13px] font-semibold">Demo wallet</span>
          <span className="text-2xl font-bold">{w?.usdcUnits ? usdc(w.usdcUnits) : "—"} USDC</span>
          <span className="text-xs text-ink-3">
            {hbar(w?.hbarTinybars)} HBAR ·{" "}
            {w?.account && (
              <a className={link} href={`https://hashscan.io/testnet/account/${w.account}`}>
                {w.account}
              </a>
            )}
          </span>
          {w?.warnings?.map((x) => (
            <span key={x} className="text-xs font-semibold text-bad">
              {x}
            </span>
          ))}
        </div>
        <div className={card}>
          <span className="text-[13px] font-semibold">Concierge (pays gas for releases)</span>
          <span className="text-2xl font-bold">{hbar(c?.hbarTinybars)} HBAR</span>
          <span className="text-xs text-ink-3">{c?.account ?? "no Hedera account found"}</span>
        </div>
        <div className={card}>
          <span className="text-[13px] font-semibold">Free money today</span>
          <span className="text-2xl font-bold">
            {f ? `${usdc(f.feesTodayUnits)} / ${usdc(f.budgetUnits)}` : "—"} USDC
          </span>
          <span className="text-xs text-ink-3">
            demo fees · {p.giftsToday ?? 0} / {p.giftsPerDay ?? 0} Face ID wallets gifted
          </span>
        </div>
      </section>
      <p className="-mt-3 text-sm text-ink-3">
        Top up the demo wallet{w?.account ? ` (${w.account})` : ""}: USDC from the{" "}
        <a
          className="text-teal underline"
          href="https://faucet.circle.com/"
          target="_blank"
          rel="noreferrer"
        >
          Circle faucet
        </a>{" "}
        (Hedera testnet), HBAR from the{" "}
        <a
          className="text-teal underline"
          href="https://portal.hedera.com/faucet"
          target="_blank"
          rel="noreferrer"
        >
          Hedera faucet
        </a>
        . Both ask for a captcha, so it's done by hand.
      </p>

      <section aria-label="People" className="flex flex-wrap gap-3">
        {PEOPLE.map(([k, label]) => (
          <div key={k} className="flex min-w-[120px] flex-col rounded-xl bg-side px-4 py-3">
            <span className="text-xs text-ink-3">{label}</span>
            <span className="text-xl font-bold">{p[k] ?? 0}</span>
          </div>
        ))}
      </section>

      <OpsAgents agents={ops.agents} onChange={load} />

      <section aria-labelledby="ops-hires" className="flex flex-col gap-3">
        <h2 id="ops-hires" className="text-lg font-bold">
          Latest hires
        </h2>
        <ul className="overflow-hidden rounded-2xl border border-line">
          {ops.recentHires.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted">None yet.</li>
          )}
          {ops.recentHires.map((h) => (
            <li
              key={`${h.at}${h.hederaTx}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#F1EEE8] px-4 py-3 text-sm first:border-t-0"
            >
              <span className="w-[150px] text-xs text-muted">{when(h.at)}</span>
              <span className="font-semibold">{h.agent}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3">{h.chatTitle}</span>
              <span className="font-mono">{usdc(h.feeUnits)}</span>
              <a
                className="text-xs text-teal underline"
                href={hashscanTx(h.hederaTx)}
                target="_blank"
                rel="noreferrer"
              >
                HashScan
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
