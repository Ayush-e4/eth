"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { shortAddress, usdc } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  BoardIcon,
  ChatIcon,
  ExitIcon,
  EyeIcon,
  LedgerIcon,
  LogoMark,
  MarketIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  TasksIcon,
  WalletIcon,
} from "../icons";

const LIVE = [
  { href: "/chat", label: "Chat", Icon: ChatIcon },
  { href: "/tasks", label: "Tasks", Icon: TasksIcon },
  { href: "/wallet", label: "Wallet", Icon: WalletIcon },
  { href: "/board", label: "Open tasks", Icon: BoardIcon },
  { href: "/market", label: "Market", Icon: MarketIcon },
  { href: "/build", label: "List your agent", Icon: PlusIcon },
  { href: "/log", label: "Public log", Icon: LedgerIcon },
  { href: "/status", label: "Status", Icon: ShieldIcon },
];

// Screens from the mocks that arrive in later PRs: shown so the app's shape is clear.
const SOON = [{ label: "Watchers", Icon: EyeIcon }];

const navItem = "flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-sm";

export function Sidebar() {
  const pathname = usePathname();
  const { me, chats, signOut } = useSession();
  const [query, setQuery] = useState("");
  const shown = query
    ? chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : chats;

  return (
    <aside
      aria-label="Sidebar"
      className="flex flex-[1_1_264px] flex-col gap-[18px] border-r border-line bg-side px-3 py-3.5 md:max-w-[300px]"
    >
      <Link href="/chat" className="flex items-center gap-2.5 px-1">
        <span className="flex size-[30px] items-center justify-center rounded-[9px] bg-teal text-white">
          <LogoMark size={17} />
        </span>
        <span className="text-[17px] font-bold">AgentNet</span>
      </Link>

      <div className="flex flex-col gap-2">
        <Link
          href="/chat"
          className="flex h-11 items-center gap-2.5 rounded-xl bg-teal px-3.5 text-sm font-semibold text-white hover:bg-teal-dark"
        >
          <PlusIcon /> New chat
        </Link>
        <label className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-white px-3">
          <SearchIcon size={16} className="text-muted" />
          <span className="sr-only">Search chats</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#6B747C]"
          />
        </label>
      </div>

      <nav aria-label="Main">
        <ul className="flex flex-col gap-0.5">
          {LIVE.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className={`${navItem} ${pathname === href ? "border border-line bg-white font-semibold" : "font-medium text-ink-2 hover:bg-white/60"}`}
              >
                <Icon /> {label}
              </Link>
            </li>
          ))}
          {SOON.map(({ label, Icon }) => (
            <li key={label}>
              <span
                aria-disabled="true"
                className={`${navItem} cursor-default font-medium text-muted`}
              >
                <Icon /> {label}
                <span className="ml-auto rounded-full bg-line px-2 py-0.5 text-[11px] font-semibold text-ink-3">
                  Soon
                </span>
              </span>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="side-recent" className="flex min-h-0 flex-col gap-0.5">
        <h2
          id="side-recent"
          className="px-3 pb-1 text-[11px] font-bold tracking-wider text-muted uppercase"
        >
          Recent
        </h2>
        {shown.length === 0 && (
          <p className="px-3 text-sm text-muted">
            {query ? "No chats match." : "Your chats will show up here."}
          </p>
        )}
        <ul className="flex flex-col gap-0.5 overflow-y-auto">
          {shown.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            return (
              <li key={c.id}>
                <Link
                  href={`/chat/${c.id}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-[38px] items-center truncate rounded-[10px] px-3 text-sm ${active ? "border border-line bg-white font-semibold" : "text-ink-2 hover:bg-white/60"}`}
                >
                  <span className="truncate">{c.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-auto flex items-stretch gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-xl border border-line bg-white p-3">
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex size-[30px] flex-none items-center justify-center rounded-full bg-teal-soft text-[13px] font-bold text-teal"
            >
              {(me?.displayName ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">
                {me?.displayName ?? (me?.isDemo ? "Demo" : "You")}
              </span>
              <span className="truncate font-mono text-xs text-muted">
                {me?.address ? shortAddress(me.address) : me?.isDemo ? "demo account" : "…"}
              </span>
            </span>
          </span>
          {me && (
            <span className="text-xs text-ink-3">
              New chats: {me.defaultMode === "auto" ? "Auto" : "Ask first"} · up to{" "}
              <span className="font-mono text-ink">{usdc(me.defaultLimitUnits)}</span> USDC
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Sign out"
          onClick={signOut}
          className="flex w-11 flex-none items-center justify-center rounded-xl border border-line bg-white text-ink-3 hover:text-ink"
        >
          <ExitIcon />
        </button>
      </div>
    </aside>
  );
}
