"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, arkivEntity, shortAddress, usdc } from "@/lib/api";
import { ChatWithAgent } from "./ChatWithAgent";
import { type AgentDetail, feeText, initials, SKILL_TONE, stars } from "./types";

const ERC8004_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
type Field = {
  type?: unknown;
  anyOf?: { type?: unknown }[];
  description?: string;
  default?: unknown;
};
const typeOf = (p: Field): string => {
  const t = p.type ?? p.anyOf?.map((x) => x.type);
  return Array.isArray(t)
    ? t.filter((x) => x !== "null").join(" or ") || "any"
    : String(t ?? "any");
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-2xl border border-line p-[18px]"
    >
      <h2 className="text-[15px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

/** One agent in full: what it costs, what it accepts, its track record and why to trust it. */
export function AgentView({ address }: { address: string }) {
  const [a, setA] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ agent: AgentDetail }>(`/market/agents/${address}`)
      .then((r) => setA(r.agent))
      .catch((e: Error) => setError(e.message));
  }, [address]);

  if (!a)
    return (
      <p className="p-10 text-center text-muted">{error ?? "Reading the agent from Arkiv…"}</p>
    );
  const props = Object.entries(a.inputSchema?.properties ?? {});
  const required = new Set(a.inputSchema?.required ?? []);
  const rating = stars(a.identity?.averageScore);

  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 pt-8 pb-14 sm:px-8">
      <Link href="/market" className="text-sm text-teal">
        ← Market
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <span
          aria-hidden
          className={`flex size-14 flex-none items-center justify-center rounded-2xl text-lg font-bold ${SKILL_TONE[a.skill] ?? "bg-bubble text-ink-3"}`}
        >
          {initials(a.name)}
        </span>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
          <h1 className="text-[28px] font-bold tracking-tight">{a.name}</h1>
          <span className="text-sm text-muted">
            {a.skill} ·{" "}
            {a.up === null ? "status unknown" : a.up ? "up now" : "not answering right now"}
            {rating &&
              ` · ★ ${rating} from ${a.identity?.paidJobs} paid job${a.identity?.paidJobs === 1 ? "" : "s"}`}
          </span>
          <p className="mt-1 text-[15px] leading-relaxed text-ink-3">{a.description}</p>
        </div>
        <ChatWithAgent agent={a.agent} name={a.name} primary />
      </div>

      <Section title="What it costs">
        <p className="text-sm text-ink-3">
          <strong className="font-mono text-ink">{feeText(a.priceUnits)}</strong>{" "}
          {Number(a.priceUnits) > 1 ? "per job, paid only when you hire it." : `(${a.title}).`}{" "}
          Quotes are free. If a paid job fails, the fee is refunded, and the refund is recorded on
          Arkiv.
        </p>
      </Section>

      <Section title="What to send it">
        {props.length ? (
          <ul className="flex flex-col divide-y divide-[#F1EEE8]">
            {props.map(([name, p]) => (
              <li key={name} className="flex flex-wrap gap-x-3 gap-y-1 py-2 text-sm">
                <span className="font-mono font-semibold">{name}</span>
                <span className="text-xs text-muted">
                  {typeOf(p as Field)}
                  {required.has(name)
                    ? " · required"
                    : p.default !== undefined
                      ? ` · optional, defaults to ${JSON.stringify(p.default)}`
                      : " · optional"}
                </span>
                {p.description && <span className="basis-full text-ink-3">{p.description}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">It didn't share its input format just now.</p>
        )}
      </Section>

      <Section title="Track record">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Jobs through AgentNet", String(a.jobsHere)],
            ["Earned here", `${usdc(a.earnedHereUnits)} USDC`],
            ["Delivered (on Arkiv)", String(a.delivered)],
            ["Refunded (on Arkiv)", String(a.refunded)],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 rounded-xl bg-side p-3">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="font-mono text-lg font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        {a.deliveries.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {a.deliveries.map((d) => (
              <li key={d.key} className="flex flex-wrap items-center gap-2">
                <span className={d.status === "delivered" ? "text-ok" : "text-saffron-ink"}>
                  {d.status}
                </span>
                <span className="font-mono text-xs text-muted">{d.task}</span>
                <a
                  className="ml-auto text-xs text-teal"
                  href={arkivEntity(d.key)}
                  target="_blank"
                  rel="noreferrer"
                >
                  record on Arkiv
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Why you can trust it">
        <ul className="flex flex-col gap-2 text-sm text-ink-3">
          <li>
            Listing signed by its own key{" "}
            <span className="font-mono text-ink">{shortAddress(a.agent)}</span>
            {a.profileKey && (
              <>
                {" "}
                (
                <a
                  className="text-teal"
                  href={arkivEntity(a.profileKey)}
                  target="_blank"
                  rel="noreferrer"
                >
                  on Arkiv
                </a>
                )
              </>
            )}
            . Nobody else can change what it says.
          </li>
          {a.hederaAccount && (
            <li>
              Gets paid to Hedera account{" "}
              <a
                className="font-mono text-teal"
                href={`https://hashscan.io/testnet/account/${a.hederaAccount}`}
                target="_blank"
                rel="noreferrer"
              >
                {a.hederaAccount}
              </a>
              , and only through spending limits you approve.
            </li>
          )}
          {a.identity && (
            <li>
              ERC-8004 identity #{a.identity.erc8004Id} on Hedera (
              <a
                className="text-teal"
                href={`https://hashscan.io/testnet/contract/${ERC8004_IDENTITY}`}
                target="_blank"
                rel="noreferrer"
              >
                the shared registry
              </a>
              ); reviews come only from clients who paid it.
            </li>
          )}
          <li>
            Service: <span className="font-mono text-xs">{a.endpoint}</span>
          </li>
        </ul>
      </Section>
    </main>
  );
}
