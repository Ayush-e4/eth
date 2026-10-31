import type { Card } from "@eth/shared";
import { hashscanTx, usdc } from "@/lib/api";

type Hired = Extract<Card, { type: "hired" }>;

/**
 * Pay on delivery, as it happened: the fee was held by the spending-limit contract, the agent
 * marked the job delivered, then the concierge paid it out. Each step links its proof on Hedera.
 */
export function EscrowSteps({ card }: { card: Hired }) {
  const e = card.escrow;
  if (!e) return null;
  const steps: { label: string; tx?: string; done: boolean }[] = [
    { label: `${usdc(card.feeUnits)} USDC held until delivery`, tx: card.hederaTx, done: true },
    { label: `${card.title} marked it delivered`, tx: e.deliveredTx, done: !!e.deliveredTx },
    e.releasedTx || !e.releaseFailed
      ? { label: `Paid out to ${card.title}`, tx: e.releasedTx, done: !!e.releasedTx }
      : { label: `${card.title} can claim it after the review window`, done: false },
  ];
  return (
    <ol aria-label="Pay on delivery" className="flex w-full flex-wrap gap-x-4 gap-y-1.5 pl-[42px]">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className={`size-2 rounded-full ${s.done ? "bg-ok" : "border border-line-2 bg-white"}`}
          />
          {s.tx ? (
            <a className="text-teal" href={hashscanTx(s.tx)} target="_blank" rel="noreferrer">
              {s.label}
            </a>
          ) : (
            <span className={s.done ? "" : "text-muted"}>{s.label}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
