"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, hashscanTopic, hashscanTx, usdc, when } from "@/lib/api";

interface Probe {
  name: string;
  ok: boolean;
  detail?: string;
}
interface Status {
  at: string;
  ok: boolean;
  services: Probe[];
  networks: Probe[];
  wallet: {
    account: string;
    reachable: boolean;
    usdcUnits?: string;
    hbarTinybars?: string;
    warnings: string[];
  } | null;
  demo: { feesTodayUnits: string; budgetUnits: string } | null;
  lastPayment: { at: string; agent: string; feeUnits: string; hederaTx: string } | null;
  logTopic: string | null;
}

const hbar = (tinybars: string) => (Number(tinybars) / 1e8).toFixed(0);

function Row({ p }: { p: Probe }) {
  return (
    <li className="flex items-center gap-3 border-t border-[#F1EEE8] px-4 py-3 first:border-t-0">
      <span
        aria-hidden
        className={`size-2.5 flex-none rounded-full ${p.ok ? "bg-ok" : "bg-bad"}`}
      />
      <span className="text-sm font-semibold">{p.name}</span>
      {p.detail && <span className="text-xs text-muted">{p.detail}</span>}
      <span className={`ml-auto text-xs font-semibold ${p.ok ? "text-ok" : "text-bad"}`}>
        {p.ok ? "up" : "down"}
      </span>
    </li>
  );
}

function Group({ title, items }: { title: string; items: Probe[] }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-2xl border border-line">
      <div className="bg-side px-4 py-3 text-[13px] font-semibold">{title}</div>
      <ul>
        {items.map((p) => (
          <Row key={p.name} p={p} />
        ))}
      </ul>
    </section>
  );
}

/** Is everything up? Refreshes every 30 seconds. */
export function StatusView() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      api<Status>("/status")
        .then((v) => {
          setS(v);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 pt-8 pb-14 sm:px-8">
      <div className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-teal">
          ← AgentNet
        </Link>
        <h1 className="text-[32px] font-bold tracking-tight">Status</h1>
        {s ? (
          <p
            role="status"
            className={`rounded-xl px-4 py-3 text-[15px] font-semibold ${s.ok ? "bg-ok-soft text-ok" : "bg-saffron-soft text-saffron-ink"}`}
          >
            {s.ok ? "Everything is working." : "Something needs attention (see below)."}
            <span className="ml-2 text-xs font-normal">checked {when(s.at)}</span>
          </p>
        ) : (
          <p className="text-muted">{error ?? "Checking…"}</p>
        )}
      </div>
      {s && (
        <>
          <Group title="Services" items={s.services} />
          <Group title="Networks" items={s.networks} />
          {s.wallet && (
            <section
              aria-label="Shared demo wallet"
              className="flex flex-col gap-2 rounded-2xl border border-line p-4 text-sm"
            >
              <span className="font-semibold">Shared demo wallet</span>
              {s.wallet.reachable ? (
                <span className="text-ink-3">
                  {usdc(s.wallet.usdcUnits ?? "0")} test USDC and{" "}
                  {hbar(s.wallet.hbarTinybars ?? "0")} HBAR on Hedera account{" "}
                  <a
                    className="font-mono text-teal"
                    href={`https://hashscan.io/testnet/account/${s.wallet.account}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.wallet.account}
                  </a>
                  {s.demo &&
                    `. Demo accounts have spent ${usdc(s.demo.feesTodayUnits)} of today's ${usdc(s.demo.budgetUnits)} USDC for agent fees.`}
                </span>
              ) : (
                <span className="text-bad">Couldn't read its balance right now.</span>
              )}
              {s.wallet.warnings.map((w) => (
                <span key={w} className="text-saffron-ink">
                  ⚠ {w}
                </span>
              ))}
            </section>
          )}
          {s.lastPayment && (
            <p className="text-sm text-ink-3">
              Latest payment: {usdc(s.lastPayment.feeUnits)} USDC to {s.lastPayment.agent},{" "}
              {when(s.lastPayment.at)} (
              <a
                className="text-teal"
                href={hashscanTx(s.lastPayment.hederaTx)}
                target="_blank"
                rel="noreferrer"
              >
                on HashScan
              </a>
              ).{" "}
              {s.logTopic && (
                <a
                  className="text-teal"
                  href={hashscanTopic(s.logTopic)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Public log
                </a>
              )}
            </p>
          )}
        </>
      )}
    </main>
  );
}
