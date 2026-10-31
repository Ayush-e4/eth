"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { shortAddress, usdc } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  BoardIcon,
  ChatIcon,
  ChevronIcon,
  CloseIcon,
  ExitIcon,
  EyeIcon,
  GaugeIcon,
  LedgerIcon,
  LogoMark,
  MarketIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  TasksIcon,
  WalletIcon,
} from "../icons";

const MAIN = [
  { href: "/chat", label: "Chat", Icon: ChatIcon },
  { href: "/tasks", label: "Tasks", Icon: TasksIcon },
  { href: "/wallet", label: "Wallet", Icon: WalletIcon },
  { href: "/watchers", label: "Watchers", Icon: EyeIcon },
  { href: "/market", label: "Market", Icon: MarketIcon },
];
const MORE = [
  { href: "/board", label: "Open tasks", Icon: BoardIcon },
  { href: "/build", label: "List your agent", Icon: PlusIcon },
  { href: "/log", label: "Public log", Icon: LedgerIcon },
  { href: "/status", label: "Status", Icon: ShieldIcon },
];

const navItem = "flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-sm md:min-h-9";

/**
 * Desktop: beside the page, full height, still while the page scrolls (only the recent chats
 * scroll inside it). Phones: a drawer that slides in from the left; any link closes it.
 */
export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const { me, chats, signOut } = useSession();
  const [query, setQuery] = useState("");
  const shown = query
    ? chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : chats;
  const more = [
    ...MORE,
    ...(me?.roles.includes("admin") ? [{ href: "/ops", label: "Ops", Icon: GaugeIcon }] : []),
  ];
  const item = ({ href, label, Icon }: (typeof MAIN)[number]) => (
    <li key={href}>
      <Link
        href={href}
        onClick={onClose}
        aria-current={pathname === href ? "page" : undefined}
        className={`${navItem} ${pathname === href ? "border border-line bg-white font-semibold" : "font-medium text-ink-2 hover:bg-white/60"}`}
      >
        <Icon /> {label}
      </Link>
    </li>
  );

  return (
    <aside
      aria-label="Sidebar"
      data-open={open}
      className="fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[85vw] -translate-x-full flex-col gap-4 overflow-y-auto border-r border-line bg-side px-3 pt-3.5 pb-[max(14px,env(safe-area-inset-bottom))] transition-transform duration-200 data-[open=true]:translate-x-0 md:sticky md:top-0 md:z-auto md:h-dvh md:w-[272px] md:max-w-none md:flex-none md:translate-x-0 md:transition-none"
    >
      <div className="flex items-center justify-between">
        <Link href="/chat" onClick={onClose} className="flex items-center gap-2.5 px-1">
          <span className="flex size-[30px] items-center justify-center rounded-[9px] bg-teal text-white">
            <LogoMark size={17} />
          </span>
          <span className="text-[17px] font-bold">AgentNet</span>
        </Link>
        <button
          type="button"
          aria-label="Close the menu"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded-xl text-ink-3 md:hidden"
        >
          <CloseIcon size={20} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <Link
          href="/chat"
          onClick={onClose}
          className="flex h-11 items-center gap-2.5 rounded-xl bg-teal px-3.5 text-sm font-semibold text-white hover:bg-teal-dark"
        >
          <PlusIcon /> New chat
        </Link>
        <label className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-white px-3 focus-within:border-teal focus-within:ring-2 focus-within:ring-teal/15">
          <SearchIcon size={16} className="text-muted" />
          <span className="sr-only">Search chats</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[#6B747C] focus-visible:outline-none md:text-sm"
          />
        </label>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <ul className="flex flex-col gap-0.5">{MAIN.map(item)}</ul>
        <details open={more.some((m) => m.href === pathname)} className="group">
          <summary
            className={`${navItem} cursor-pointer list-none font-medium text-ink-3 hover:bg-white/60 [&::-webkit-details-marker]:hidden`}
          >
            <ChevronIcon size={16} className="transition-transform group-open:rotate-180" /> More
          </summary>
          <ul className="flex flex-col gap-0.5">{more.map(item)}</ul>
        </details>
      </nav>

      <section
        aria-labelledby="side-recent"
        className="flex min-h-[120px] flex-1 flex-col gap-0.5 md:min-h-0"
      >
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
        <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {shown.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            return (
              <li key={c.id}>
                <Link
                  href={`/chat/${c.id}`}
                  onClick={onClose}
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

      <div className="flex flex-none items-stretch gap-2">
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
                {me?.address
                  ? shortAddress(me.address)
                  : me?.wallet?.status === "ready"
                    ? `Face ID wallet · ${shortAddress(me.wallet.address)}`
                    : me?.passkey
                      ? "passkey · setting up wallet"
                      : me?.isDemo
                        ? "demo account"
                        : "…"}
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
