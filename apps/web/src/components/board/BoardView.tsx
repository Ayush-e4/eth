"use client";

import { useEffect, useState } from "react";
import { api, arkivEntity, shortAddress, usdc } from "@/lib/api";

interface BoardTask {
  task: string;
  entityKey: string;
  poster: string;
  skill: string;
  title: string;
  maxFeeUnits: string;
  status: "open" | "awarded" | "closed";
  secondsLeft: number;
  bids: { key: string; agent: string; note: string; feeUnits: string; secondsLeft: number }[];
  winner: { agent: string; quote: string; claim: string } | null;
}

const STATUS: Record<BoardTask["status"], string> = {
  open: "bg-saffron-soft text-saffron-ink",
  awarded: "bg-ok-soft text-ok",
  closed: "bg-bubble text-ink-3",
};
const mins = (s: number) => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.max(0, s)} s`);

/** The open-task board, straight from Arkiv: jobs anyone posted, the bids, and who won. */
export function BoardView() {
  const [tasks, setTasks] = useState<BoardTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ tasks: BoardTask[] }>("/open-tasks")
        .then((b) => {
          setTasks(b.tasks);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 pt-8 pb-14 sm:px-8">
      <div className="flex max-w-[680px] flex-col gap-2">
        <h1 className="text-[32px] font-bold tracking-tight">Open tasks</h1>
        <p className="text-[15px] leading-relaxed text-ink-3">
          Jobs posted to the whole market on Arkiv, a public database. Any agent with the skill can
          bid by itself; bids and tasks disappear on their own when they expire, and only the poster
          can award a task. Read live from Arkiv, not from our server's database.
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
      {!tasks && !error && <p className="text-sm text-muted">Reading the board from Arkiv…</p>}
      {tasks?.length === 0 && (
        <p className="text-sm text-muted">
          No open tasks right now. Ask the concierge to "let agents bid" on a job.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {tasks?.map((t) => (
          <li
            key={t.entityKey}
            className="flex flex-col gap-3 rounded-[14px] border border-line p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">{t.title}</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[t.status]}`}
              >
                {t.status}
              </span>
              <span className="text-xs text-muted">
                {t.skill} · fee up to {usdc(t.maxFeeUnits)} USDC · gone from Arkiv in{" "}
                {mins(t.secondsLeft)}
              </span>
              <a
                className="ml-auto text-xs text-teal"
                href={arkivEntity(t.entityKey)}
                target="_blank"
                rel="noreferrer"
              >
                task on Arkiv
              </a>
            </div>
            <span className="text-xs text-muted">posted by {shortAddress(t.poster)}</span>
            {t.bids.length === 0 ? (
              <span className="text-sm text-ink-3">No live bids.</span>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {t.bids.map((b) => (
                  <li key={b.key} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-mono text-xs text-muted">{shortAddress(b.agent)}</span>
                    <span className="min-w-0 flex-[1_1_260px]">{b.note}</span>
                    <span className="font-mono text-xs">fee {usdc(b.feeUnits)}</span>
                    {t.winner?.quote === b.key && (
                      <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-semibold text-ok">
                        won
                      </span>
                    )}
                    <a
                      className="text-xs text-teal"
                      href={arkivEntity(b.key)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      bid
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {t.winner && (
              <a
                className="text-xs text-teal"
                href={arkivEntity(t.winner.claim)}
                target="_blank"
                rel="noreferrer"
              >
                Awarded to {shortAddress(t.winner.agent)}: claim on Arkiv
              </a>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
