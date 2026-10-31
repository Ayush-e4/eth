"use client";

import Link from "next/link";
import { useState } from "react";
import type { ChatSummary } from "@/lib/api";

/** A chat with one agent from the Market: says so, and lets the user widen it to the whole market. */
export function AgentBanner({
  agent,
  onUnpin,
}: {
  agent: NonNullable<ChatSummary["agent"]>;
  onUnpin: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <section
      aria-label={`Working with ${agent.name}`}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-side px-4 py-3 text-sm"
    >
      <span className="min-w-0 flex-[1_1_320px] text-ink-3">
        You're working with <strong className="text-ink">{agent.name}</strong> only ({agent.skill}).
        The concierge asks just {agent.name} for quotes and can only pay {agent.name}.
      </span>
      <Link href={`/market/${agent.address}`} className="text-teal">
        About {agent.name}
      </Link>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onUnpin().finally(() => setBusy(false));
        }}
        className="flex min-h-10 items-center rounded-xl border border-line-2 bg-white px-3 font-semibold disabled:opacity-60"
      >
        Bring in the concierge
      </button>
    </section>
  );
}
