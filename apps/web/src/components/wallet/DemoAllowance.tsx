"use client";

import { useEffect, useState } from "react";
import { api, usdc } from "@/lib/api";

interface Left {
  messages: number;
  hires: number;
  limits: number;
  quotas: {
    messagesPerUser: number;
    hiresPerUser: number;
    limitsPerUser: number;
    feeUnitsPerDay: string;
  };
}

/** What this demo account can still do today (the shared test wallet has daily allowances). */
export function DemoAllowance() {
  const [left, setLeft] = useState<Left | null>(null);
  useEffect(() => {
    api<{ left: Left | null }>("/demo/quota")
      .then((r) => setLeft(r.left))
      .catch(() => {});
  }, []);
  if (!left) return null;
  const q = left.quotas;
  return (
    <section
      aria-label="Demo allowance"
      className="flex flex-col gap-1.5 rounded-2xl border border-line bg-side px-5 py-4 text-sm"
    >
      <span className="font-semibold">Today on this demo account</span>
      <span className="text-ink-3">
        {left.hires} of {q.hiresPerUser} paid hires, {left.messages} of {q.messagesPerUser} messages
        and {left.limits} of {q.limitsPerUser} spending limits left. The shared demo wallet pays up
        to {usdc(q.feeUnitsPerDay)} USDC in agent fees a day across all demo accounts; sign in with
        MetaMask to use your own test wallet without these limits.
      </span>
    </section>
  );
}
