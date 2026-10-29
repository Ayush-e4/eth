import type { Card } from "@eth/shared";

const fee = (units: string) => `${(Number(units) / 1e6).toFixed(2)} USDC`;

/**
 * Claude only sees earlier turns as text, so each card the user saw is summarised in one line.
 * That's how the concierge still knows "q2" or a pending approval on the next turn.
 */
export function cardNote(card: Card): string {
  switch (card.type) {
    case "agents":
      return `[showed agents for ${card.skill}: ${card.agents.map((a) => `${a.name} ${fee(a.priceUnits)}`).join("; ")}]`;
    case "options":
      return `[asked: ${card.question} — ${card.options.map((o) => o.label).join(" / ")}]`;
    case "quotes":
      return `[quotes for ${card.skill}: ${card.quotes
        .map(
          (q) =>
            `${q.key} ${q.title} ${q.totalInr ? `₹${q.totalInr}` : ""} fee ${fee(q.feeUnits)} — ${q.note}`,
        )
        .join("; ")}]`;
    case "limit":
      return `[asked the user to approve a limit of ${fee(card.budgetUnits)} for ${card.payees.map((p) => p.name).join(", ")}]`;
    case "approval":
      return `[asked the user to approve: ${card.title}, ${fee(card.feeUnits)}, code ${card.code}]`;
    case "hired":
      return `[hired ${card.title} for ${card.skill}, paid ${fee(card.feeUnits)}, tx ${card.hederaTx}: ${card.summary}]`;
  }
}

export const withCardNotes = (text: string, cards: Card[]) =>
  [text, ...cards.map(cardNote)].filter(Boolean).join("\n");
