import type { Card } from "@eth/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { fareWatches as table } from "../db/schema";

/** A PriceGuard watch as the agent reports it (see apps/agents/src/specialists/priceguard-routes.ts). */
export interface GuardView {
  bookingId: string;
  status: "watching" | "stopped";
  limits: { minSavingInr: number; minSavingPercent: number; until: string };
  checks: {
    at: string;
    paid: number;
    best: number | null;
    currency: string;
    saving: number;
    simulated?: boolean;
    outcome: string;
  }[];
  invoices: { key: string; units: string; saving: number; currency: string; paid: boolean }[];
}

const money = (n: number, c: string) => `${Math.round(n).toLocaleString("en-IN")} ${c}`;

/**
 * Post what's new on a PriceGuard watch: each rebook (an invoice) with a "Pay PriceGuard"
 * choice, and that it stopped watching. Claimed with a conditional update, so never twice.
 */
export async function followHotel(
  db: Db,
  row: typeof table.$inferSelect,
  v: GuardView,
  say: (chatId: string, text: string, cards?: Card[]) => Promise<unknown>,
) {
  const [claimed] = await db
    .update(table)
    .set({ alertsSeen: v.invoices.length, status: v.status })
    .where(
      and(
        eq(table.watchId, row.watchId),
        eq(table.alertsSeen, row.alertsSeen),
        eq(table.status, row.status),
      ),
    )
    .returning({ id: table.watchId });
  if (!claimed) return;
  const sim = v.checks.at(-1)?.simulated
    ? " This was a SIMULATED drop (sandbox demo): nothing real was saved, so nothing is owed."
    : "";
  for (const inv of v.invoices.slice(row.alertsSeen))
    await say(
      row.chatId,
      `PriceGuard rebooked your hotel for less: it saved ${money(inv.saving, inv.currency)} (the booking is now ${v.bookingId}). Its fee is 20% of the saving, ${(Number(inv.units) / 1e6).toFixed(2)} USDC, paid only if you say so.${sim}`,
      [
        {
          type: "options",
          question: "Pay PriceGuard?",
          options: [
            { label: "Pay PriceGuard", reply: `Pay PriceGuard's invoice ${inv.key}` },
            { label: "Not now", reply: "Not now, thanks" },
          ],
        },
      ],
    );
  if (v.status === "stopped" && row.status === "watching") {
    const why = v.checks.at(-1)?.outcome ?? "";
    await say(
      row.chatId,
      `PriceGuard stopped watching your hotel${why.startsWith("stopped:") ? ` (${why.slice(9)})` : ""}.`,
    );
  }
}
