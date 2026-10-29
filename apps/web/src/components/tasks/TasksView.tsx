"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, arkivEntity, hashscanTx, type Task, usdc, when } from "@/lib/api";
import { CheckIcon } from "../icons";

const TONE: Record<string, string> = {
  flights: "bg-[#EEEAF8] text-[#4E3D8F]",
  hotels: "bg-teal-soft text-teal",
  priceguard: "bg-saffron-soft text-saffron-ink",
  research: "bg-[#E9F3E6] text-[#2F6A2A]",
};

/** Top-level facts from an agent's result (booking reference, status, totals), never raw HTML. */
function facts(result: unknown): [string, string][] {
  if (!result || typeof result !== "object")
    return result == null ? [] : [["Result", String(result)]];
  return Object.entries(result as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 12)
    .map(([k, v]) => [
      k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
      typeof v === "object"
        ? JSON.stringify(v).slice(0, 160)
        : /^[A-Z_]+$/.test(String(v)) // e.g. PENDING_CONFIRMATION → Pending confirmation
          ? String(v).charAt(0) + String(v).slice(1).toLowerCase().replaceAll("_", " ")
          : String(v),
    ]);
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [skill, setSkill] = useState("all");
  const [selId, setSelId] = useState<string | null>(null);

  useEffect(() => {
    api<{ tasks: Task[] }>("/tasks")
      .then(({ tasks }) => setTasks(tasks))
      .catch(() => setTasks([]));
  }, []);

  const all = tasks ?? [];
  const skills = ["all", ...new Set(all.map((t) => t.skill))];
  const shown = skill === "all" ? all : all.filter((t) => t.skill === skill);
  const sel = shown.find((t) => t.id === selId) ?? shown[0];
  const spent = all.reduce((s, t) => s + BigInt(t.feeUnits), BigInt(0));

  return (
    <main className="mx-auto flex w-full max-w-[1140px] flex-col gap-6 px-6 pt-8 pb-14 sm:px-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-bold tracking-tight">Tasks</h1>
        <p className="max-w-[620px] text-[15px] leading-relaxed text-ink-3">
          Everything agents have done for you. Every payment has a receipt on Hedera and a job
          record on Arkiv that anyone can check.
        </p>
      </div>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {[
          ["Jobs done", String(all.length)],
          ["Agent fees paid", `${usdc(spent)} USDC`],
          ["Agents used", String(new Set(all.map((t) => t.agent.toLowerCase())).size)],
        ].map(([k, v]) => (
          <div
            key={k}
            className="flex flex-col gap-1 rounded-[14px] border border-line px-[18px] py-4"
          >
            <dt className="text-[13px] text-muted">{k}</dt>
            <dd className="text-[26px] font-bold">{v}</dd>
          </div>
        ))}
      </dl>

      {tasks === null ? (
        <p className="text-muted">Loading…</p>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-2 p-10 text-center">
          <span className="text-[15px] font-semibold">No tasks yet</span>
          <span className="text-sm text-ink-3">
            Ask the concierge to book something, and the agents it hires show up here.
          </span>
          <Link
            href="/chat"
            className="mt-2 flex h-11 items-center rounded-xl bg-teal px-4 text-sm font-semibold text-white"
          >
            Start a chat
          </Link>
        </div>
      ) : (
        <>
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Filter by skill</legend>
            {skills.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={skill === s}
                onClick={() => setSkill(s)}
                className={`h-10 rounded-full border px-3.5 text-sm font-medium capitalize ${skill === s ? "border-teal bg-teal text-white" : "border-line-2 bg-white"}`}
              >
                {s}
              </button>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-start gap-5">
            <ul aria-label="Tasks" className="flex min-w-0 flex-[999_1_520px] flex-col gap-2">
              {shown.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={t.id === sel?.id}
                    onClick={() => setSelId(t.id)}
                    className={`flex w-full flex-wrap items-center gap-3.5 rounded-[14px] border-2 px-4 py-3.5 text-left ${t.id === sel?.id ? "border-teal bg-teal-tint" : "border-line bg-white"}`}
                  >
                    <span
                      aria-hidden
                      className={`flex size-9 flex-none items-center justify-center rounded-[10px] text-xs font-bold ${TONE[t.skill] ?? "bg-bubble text-ink-2"}`}
                    >
                      {t.title.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                      <span className="text-[15px] font-semibold">
                        {t.title} did the {t.skill} job
                      </span>
                      <span className="truncate text-[13px] text-muted">
                        {t.chatTitle} · {when(t.createdAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-1 text-xs font-semibold text-ok">
                      <CheckIcon size={12} /> Paid
                    </span>
                    <span className="w-24 text-right font-mono text-[13px]">
                      {usdc(t.feeUnits)} USDC
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {sel && (
              <section
                aria-label="Task details"
                className="flex flex-[1_1_340px] flex-col gap-4 rounded-[18px] border border-line bg-[#FBFAF8] p-5"
              >
                <div className="flex flex-col gap-1.5">
                  <h2 className="text-[19px] leading-snug font-bold">
                    {sel.title} did the {sel.skill} job
                  </h2>
                  <span className="text-[13px] text-muted">
                    {when(sel.createdAt)} · in "{sel.chatTitle}"
                  </span>
                </div>
                <dl className="flex flex-col text-[13px]">
                  {facts(sel.result).map(([k, v]) => (
                    <div
                      key={k}
                      className="flex justify-between gap-3 border-b border-[#F1EEE8] py-2"
                    >
                      <dt className="text-ink-3">{k}</dt>
                      <dd className="text-right break-all">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-col gap-2 text-[13px]">
                  <h3 className="font-bold text-ink-3">Proof</h3>
                  <a
                    className="flex justify-between gap-3 text-teal"
                    href={hashscanTx(sel.hederaTx)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="text-ink-3">Fee {usdc(sel.feeUnits)} USDC</span>
                    <span className="font-mono text-xs">{sel.hederaTx.split("@")[0]}@…</span>
                  </a>
                  <a
                    className="flex justify-between gap-3 text-teal"
                    href={arkivEntity(sel.jobKey)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="text-ink-3">Job record on Arkiv</span>
                    <span className="font-mono text-xs">{sel.jobKey.slice(0, 10)}…</span>
                  </a>
                  <span className="flex justify-between gap-3">
                    <span className="text-ink-3">Paid under limit</span>
                    <span className="font-mono text-xs">#{sel.mandateId}</span>
                  </span>
                </div>
                <Link
                  href={`/chat/${sel.chatId}`}
                  className="flex h-11 items-center justify-center rounded-xl bg-teal text-sm font-semibold text-white"
                >
                  Open the chat
                </Link>
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}
