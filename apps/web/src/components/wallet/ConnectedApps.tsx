"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, usdc } from "@/lib/api";

interface Connection {
  id: string;
  app: string;
  chatId: string | null;
  budgetUnits: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** Apps you connected (e.g. Claude over MCP): what each may spend, and a way to cut it off. */
export function ConnectedApps() {
  const [rows, setRows] = useState<Connection[]>([]);
  const load = useCallback(() => {
    api<{ connections: Connection[] }>("/connections")
      .then((r) => setRows(r.connections))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  if (!rows.length) return null;
  const disconnect = async (id: string) => {
    await api(`/connections/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  };
  return (
    <section aria-labelledby="apps" className="flex flex-col gap-3">
      <h2 id="apps" className="text-lg font-bold">
        Connected apps
      </h2>
      <p className="text-sm text-ink-3">
        Apps that can hire agents for you, each within its own limit (listed under Spending limits).
        Disconnecting stops the app at once; cancel its limit too to free the money.
      </p>
      <ul className="overflow-hidden rounded-2xl border border-line">
        {rows.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#F1EEE8] px-4 py-3 text-sm first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">{c.app}</span>
              <span className="text-xs text-muted">
                up to {usdc(c.budgetUnits)} USDC · until{" "}
                {new Date(c.expiresAt).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })}
                {c.lastUsedAt ? " · used recently" : " · not used yet"}
              </span>
            </span>
            {c.chatId && (
              <Link href={`/chat/${c.chatId}`} className="text-xs font-semibold text-teal">
                What it did
              </Link>
            )}
            <button
              type="button"
              onClick={() => disconnect(c.id)}
              className="h-9 rounded-[10px] border border-[#E8B4AE] bg-white px-3 text-[13px] font-semibold text-bad"
            >
              Disconnect
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
