"use client";

import type { ChatMode } from "@eth/shared";
import { useState } from "react";
import { usdc } from "@/lib/api";
import { ChevronIcon, ShieldIcon } from "../icons";

const LIMITS = ["100000", "300000", "1000000", "5000000"]; // 0.10, 0.30, 1.00, 5.00 USDC

/** "Auto · up to 0.30 USDC": how this chat may spend. Opens a small panel to change it. */
export function ModePill({
  mode,
  limitUnits,
  onChange,
}: {
  mode: ChatMode;
  limitUnits: string;
  onChange: (patch: { mode?: ChatMode; limitUnits?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full border border-[#C9DEE0] bg-teal-tint px-3 text-[13px] font-medium whitespace-nowrap text-teal-dark"
      >
        <ShieldIcon size={15} />
        {mode === "auto" ? "Auto" : "Ask first"} ·<span className="hidden sm:inline"> up to</span>
        <span className="font-mono text-[12.5px]">{usdc(limitUnits)} USDC</span>
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Spending for this chat"
          className="absolute bottom-11 left-0 z-10 flex w-[min(18rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border border-line bg-white p-4 shadow-lg"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-semibold">Spending in this chat</legend>
            {(["auto", "ask"] as const).map((m) => (
              <label key={m} className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === m}
                  onChange={() => onChange({ mode: m })}
                  className="size-4 accent-teal"
                />
                {m === "auto"
                  ? "Auto: hire agents on its own within the limit"
                  : "Ask me before every payment"}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            Agent fees, up to
            <select
              value={limitUnits}
              onChange={(e) => onChange({ limitUnits: e.target.value })}
              className="h-10 rounded-[10px] border border-line-2 bg-white px-2 font-mono text-sm font-normal"
            >
              {(LIMITS.includes(limitUnits) ? LIMITS : [limitUnits, ...LIMITS]).map((u) => (
                <option key={u} value={u}>
                  {usdc(u)} USDC
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-relaxed text-muted">
            The first hire in this chat asks you to approve this limit on Hedera; agents can never
            be paid past it.
          </p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 self-end rounded-lg px-3 text-sm font-medium text-teal"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
