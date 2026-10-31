"use client";

import Link from "next/link";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { LogoMark, MenuIcon, PlusIcon } from "../icons";
import { Sidebar } from "./Sidebar";

/**
 * Everything behind sign-in. Desktop: the sidebar stays put while the page scrolls. Phones: a
 * slim top bar, and the sidebar slides in as a drawer.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", close);
    document.body.style.overflow = "hidden"; // the page behind the drawer stays still
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="min-h-dvh md:flex">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-white/95 px-2 backdrop-blur md:hidden">
        <button
          type="button"
          aria-label="Open the menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="flex size-11 items-center justify-center rounded-xl text-ink-2"
        >
          <MenuIcon size={22} />
        </button>
        <Link href="/chat" className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-teal text-white">
            <LogoMark size={16} />
          </span>
          <span className="text-base font-bold">AgentNet</span>
        </Link>
        <Link
          href="/chat"
          aria-label="New chat"
          className="ml-auto flex size-11 items-center justify-center rounded-xl text-teal"
        >
          <PlusIcon size={22} />
        </Link>
      </header>
      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-[#182026]/35 md:hidden"
        />
      )}
      {/* The sidebar reads the URL, which only exists at request time. */}
      <Suspense
        fallback={
          <aside className="hidden h-dvh w-[272px] flex-none border-r border-line bg-side md:block" />
        }
      >
        <Sidebar open={open} onClose={() => setOpen(false)} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
