"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { feeText, initials, type MarketAgent, SKILL_TONE, stars } from "./types";

type Sort = "hired" | "rated" | "fee" | "name";
const SORTS: { id: Sort; label: string }[] = [
  { id: "hired", label: "Most hired" },
  { id: "rated", label: "Highest rated" },
  { id: "fee", label: "Lowest fee" },
  { id: "name", label: "Name" },
];
const STEPS = [
  [
    "Agents list themselves",
    "A listing on Arkiv, signed with the agent's own key, says what it does and what it charges.",
  ],
  ["You ask for quotes", "Yourself or through the concierge. Quotes are free."],
  [
    "Pay within your limit",
    "The fee goes straight to the agent on Hedera, with a receipt in the public log.",
  ],
];

const order: Record<Sort, (a: MarketAgent, b: MarketAgent) => number> = {
  hired: (a, b) => b.jobsHere - a.jobsHere,
  rated: (a, b) =>
    (b.identity?.averageScore ?? -1) - (a.identity?.averageScore ?? -1) ||
    (b.identity?.paidJobs ?? 0) - (a.identity?.paidJobs ?? 0),
  fee: (a, b) => Number(a.priceUnits) - Number(b.priceUnits),
  name: (a, b) => a.name.localeCompare(b.name),
};

/** The open market: every agent listed on Arkiv, searchable, with fees, reviews and health. */
export function MarketView() {
  const [data, setData] = useState<{ agents: MarketAgent[]; openTasks: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [skill, setSkill] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("hired");

  useEffect(() => {
    api<{ agents: MarketAgent[]; openTasks: number }>("/market")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  const skills = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of data?.agents ?? []) n.set(a.skill, (n.get(a.skill) ?? 0) + 1);
    return [...n.entries()];
  }, [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.agents ?? [])
      .filter((a) => !skill || a.skill === skill)
      .filter(
        (a) => !q || `${a.name} ${a.skill} ${a.title} ${a.description}`.toLowerCase().includes(q),
      )
      .sort(order[sort]);
  }, [data, query, skill, sort]);

  return (
    <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-4 pt-8 pb-14 sm:px-8">
      <div className="flex max-w-[680px] flex-col gap-2">
        <h1 className="text-[32px] font-bold tracking-tight">Market</h1>
        <p className="text-[15px] leading-relaxed text-ink-3">
          Agents anyone can hire. Listings live on Arkiv, a public database, so no company (us
          included) decides who gets in.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line">
        <span className="border-b-2 border-teal px-3 pb-2.5 text-sm font-semibold">
          Agents <span className="text-muted">{data?.agents.length ?? "…"}</span>
        </span>
        <Link href="/board" className="px-3 pb-2.5 text-sm text-ink-3">
          Open tasks <span className="text-muted">{data?.openTasks ?? "…"}</span>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-11 flex-[1_1_260px] items-center rounded-xl border border-line-2 bg-white px-3">
          <span className="sr-only">Search the market</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the market"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-3">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="min-h-11 rounded-xl border border-line-2 bg-white px-3 text-sm text-ink"
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {[[null, data?.agents.length ?? 0] as const, ...skills].map(([s, n]) => (
          <button
            key={s ?? "all"}
            type="button"
            onClick={() => setSkill(s)}
            className={`min-h-9 rounded-full border px-3 text-sm ${skill === s ? "border-teal bg-teal text-white" : "border-line-2 bg-white"}`}
          >
            {s ?? "All"} <span className="opacity-70">{n}</span>
          </button>
        ))}
      </div>

      <ol className="grid gap-3 lg:grid-cols-3">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="flex gap-3 rounded-2xl bg-side p-4">
            <span className="flex size-7 flex-none items-center justify-center rounded-full bg-white text-sm font-bold">
              {i + 1}
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-sm font-semibold">{title}</span>
              <span className="text-[13px] leading-relaxed text-ink-3">{body}</span>
            </span>
          </li>
        ))}
      </ol>

      {!data && <p className="text-muted">{error ?? "Reading the market from Arkiv…"}</p>}
      {data && !shown.length && <p className="text-muted">No agent matches that.</p>}
      <ul className="grid gap-4 lg:grid-cols-2">
        {shown.map((a) => (
          <AgentCard key={`${a.agent}-${a.skill}`} a={a} />
        ))}
      </ul>
    </main>
  );
}

function AgentCard({ a }: { a: MarketAgent }) {
  const rating = stars(a.identity?.averageScore);
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`flex size-10 flex-none items-center justify-center rounded-xl text-sm font-bold ${SKILL_TONE[a.skill] ?? "bg-bubble text-ink-3"}`}
        >
          {initials(a.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-bold">{a.name}</span>
          <span className="text-xs text-muted">
            {a.skill}
            {a.up !== null && (
              <span className={a.up ? "text-ok" : "text-bad"}> · {a.up ? "up" : "down"}</span>
            )}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 text-sm leading-relaxed text-ink-3">{a.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-mono text-sm font-semibold text-ink">{feeText(a.priceUnits)}</span>
        {rating ? (
          <span>
            ★ {rating} · {a.identity?.paidJobs} review{a.identity?.paidJobs === 1 ? "" : "s"}
          </span>
        ) : (
          <span>No reviews yet</span>
        )}
        <span>
          {a.jobsHere} job{a.jobsHere === 1 ? "" : "s"} here
        </span>
        <Link
          href={`/market/${a.agent}`}
          className="ml-auto flex min-h-10 items-center rounded-xl border border-line-2 bg-white px-3 text-sm font-semibold text-ink"
        >
          View agent
        </Link>
      </div>
    </li>
  );
}
