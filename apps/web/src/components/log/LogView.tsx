"use client";

import { useEffect, useState } from "react";
import {
  api,
  arkivEntity,
  hashscanTopic,
  hashscanTx,
  type LogEntry,
  shortAddress,
  usdc,
  when,
} from "@/lib/api";

type Names = Record<string, string>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One log entry in plain words, with a link to its proof where there is one. */
function describe(
  e: LogEntry,
  names: Names,
): { what: string; tag: string; proof?: [string, string] } {
  const who = (v: unknown) =>
    names[str(v).toLowerCase()] ?? (str(v).startsWith("0x") ? shortAddress(str(v)) : str(v));
  switch (e.kind) {
    case "x402.settled":
      return {
        tag: "Payment",
        what: `${usdc(str(e.amount))} USDC from ${who(e.payer)} to ${who(e.payTo)}, under limit #${str(e.mandateId)}`,
        proof: ["transfer", hashscanTx(str(e.transaction))],
      };
    case "agentnet.hired":
      return {
        tag: "Hire",
        what: `Hired ${who(e.agent)} for ${str(e.skill)}, fee ${usdc(str(e.fee))} USDC, under limit #${str(e.mandateId)}`,
        proof: ["job on Arkiv", arkivEntity(str(e.job))],
      };
    case "agentnet.mandate.created":
      return {
        tag: "New limit",
        what: `Limit #${str(e.mandateId)}: up to ${usdc(str(e.budget))} USDC, only to ${Array.isArray(e.payees) ? e.payees.map(who).join(", ") : "?"}, set by ${who(e.owner)}`,
      };
    case "agentnet.mandate.revoked":
      return { tag: "Cancelled", what: `Limit #${str(e.mandateId)} cancelled by ${who(e.by)}` };
    default:
      return { tag: "Note", what: str(e.text) || e.kind };
  }
}

const TAG: Record<string, string> = {
  Payment: "bg-teal-soft text-teal",
  Hire: "bg-[#EEEAF8] text-[#4E3D8F]",
  "New limit": "bg-ok-soft text-ok",
  Cancelled: "bg-bad-soft text-bad",
  Note: "bg-bubble text-ink-3",
};

export function LogView() {
  const [log, setLog] = useState<{ topic: string; entries: LogEntry[]; names: Names } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ topic: string; entries: LogEntry[]; names: Names }>("/spend-log")
      .then(setLog)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 pt-8 pb-14 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-[680px] flex-col gap-2">
          <h1 className="text-[32px] font-bold tracking-tight">Public spending log</h1>
          <p className="text-[15px] leading-relaxed text-ink-3">
            Every agent payment, hire and spending limit on AgentNet is appended to one public log
            on Hedera (a Consensus Service topic). Each entry gets a number and a timestamp from the
            network. Nobody can edit or delete an entry, not even us, and anyone can read them.
          </p>
        </div>
        {log && (
          <a
            href={hashscanTopic(log.topic)}
            target="_blank"
            rel="noreferrer"
            className="flex h-11 items-center rounded-xl border border-line-2 bg-white px-4 font-mono text-sm font-semibold"
          >
            Topic {log.topic} on HashScan
          </a>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
      {!log && !error && <p className="text-sm text-muted">Reading the log from Hedera…</p>}
      {log && log.entries.length === 0 && <p className="text-sm text-muted">No entries yet.</p>}

      {log && log.entries.length > 0 && (
        <ol className="overflow-hidden rounded-[14px] border border-line">
          {log.entries.map((e) => {
            const d = describe(e, log.names);
            return (
              <li
                key={e.seq}
                className="flex flex-wrap items-center gap-3 border-t border-[#F1EEE8] px-4 py-3 text-sm first:border-t-0"
              >
                <span className="w-12 font-mono text-ink-3">#{e.seq}</span>
                <span className="w-32 text-ink-3">{when(e.at)}</span>
                <span
                  className={`w-24 rounded-full px-2.5 py-0.5 text-center text-xs font-semibold ${TAG[d.tag] ?? TAG.Note}`}
                >
                  {d.tag}
                </span>
                <span className="min-w-0 flex-[1_1_320px] break-words">{d.what}</span>
                {d.proof && (
                  <a
                    className="text-xs text-teal"
                    href={d.proof[1]}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {d.proof[0]}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
