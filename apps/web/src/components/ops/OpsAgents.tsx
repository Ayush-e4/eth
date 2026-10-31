"use client";

import { useState } from "react";
import { ApiError, api, usdc } from "@/lib/api";

export interface OpsAgent {
  name: string;
  skill: string;
  agent: string;
  priceUnits: string;
  up: boolean | null;
  jobsHere: number;
  earnedHereUnits: string;
  lastJobAt: string | null;
  hidden: { reason: string; at: string } | null;
}

const btn =
  "h-9 rounded-[10px] border border-line-2 bg-white px-3 text-[13px] font-semibold disabled:opacity-50";

/** Every listed agent, hidden ones too, with the switch that takes one off AgentNet. */
export function OpsAgents({ agents, onChange }: { agents: OpsAgent[]; onChange: () => void }) {
  const [hiding, setHiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body });
      setHiding(null);
      setReason("");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ops-agents" className="flex flex-col gap-3">
      <h2 id="ops-agents" className="text-lg font-bold">
        Agents
      </h2>
      <p className="text-sm text-ink-3">
        Hiding an agent takes it off the Market page and out of the concierge's search and quotes at
        once. Its Arkiv listing is its own and stays; AgentNet just stops using it.
      </p>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <ul className="overflow-hidden rounded-2xl border border-line">
        {agents.map((a) => (
          <li
            key={`${a.agent}:${a.skill}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#F1EEE8] px-4 py-3 first:border-t-0"
          >
            <span
              aria-hidden
              className={`size-2.5 flex-none rounded-full ${a.up === null ? "bg-line-2" : a.up ? "bg-ok" : "bg-bad"}`}
            />
            <span className="flex min-w-[160px] flex-1 flex-col">
              <span className="text-sm font-semibold">
                {a.name} <span className="font-normal text-muted">· {a.skill}</span>
              </span>
              <span className="font-mono text-xs text-muted">
                {a.agent.slice(0, 6)}…{a.agent.slice(-4)} · {usdc(a.priceUnits)} USDC a job
              </span>
            </span>
            <span className="text-xs text-ink-3">
              {a.up === null ? "not checked" : a.up ? "up" : "down"} · {a.jobsHere} jobs here ·{" "}
              {usdc(a.earnedHereUnits)} USDC earned
            </span>
            {a.hidden ? (
              <span className="flex items-center gap-2">
                <span className="rounded-full bg-bad-soft px-2.5 py-1 text-xs font-semibold text-bad">
                  Hidden: {a.hidden.reason}
                </span>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => run(`/ops/agents/${a.agent}/unhide`)}
                >
                  Unhide
                </button>
              </span>
            ) : hiding === a.agent ? (
              <form
                className="flex w-full flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(`/ops/agents/${a.agent}/hide`, { reason });
                }}
              >
                <input
                  aria-label={`Why hide ${a.name}`}
                  className="h-9 min-w-[220px] flex-1 rounded-[10px] border border-line-2 px-3 text-sm"
                  placeholder="Why? (e.g. sends junk results)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button type="submit" className={`${btn} text-bad`} disabled={busy}>
                  Hide {a.name}
                </button>
                <button type="button" className={btn} onClick={() => setHiding(null)}>
                  Keep it
                </button>
              </form>
            ) : (
              <button type="button" className={btn} onClick={() => setHiding(a.agent)}>
                Hide…
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
