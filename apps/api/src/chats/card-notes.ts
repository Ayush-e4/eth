import type { Card } from "@eth/shared";

const fee = (units: string) => `${(Number(units) / 1e6).toFixed(2)} USDC`;

/**
 * Claude only sees earlier turns as text, so each card the user saw is summarised in one line.
 * That's how the concierge still knows "q2" or a pending approval on the next turn. The "[app:"
 * prefix marks them as records of what its tools really did (the prompt says to trust them);
 * plain brackets read like its own notes, and Haiku once doubted it had searched at all.
 */
export function cardNote(card: Card): string {
  switch (card.type) {
    case "agents":
      return `[app: find_agents showed agents for ${card.skill}: ${card.agents.map((a) => `${a.name} ${fee(a.priceUnits)}`).join("; ")}]`;
    case "options":
      return `[app: show_options asked: ${card.question} — ${card.options.map((o) => o.label).join(" / ")}]`;
    case "quotes":
      return `[app: get_quotes returned real quotes for ${card.skill}: ${card.quotes
        .map(
          (q) =>
            `${q.key} ${q.title} ${q.totalInr ? `₹${q.totalInr}` : ""} fee ${fee(q.feeUnits)} — ${q.note}`,
        )
        .join("; ")}]`;
    case "limit":
      return `[app: hire_agent asked the user to approve a limit of ${fee(card.budgetUnits)} for ${card.payees.map((p) => p.name).join(", ")}]`;
    case "approval":
      return `[app: hire_agent asked the user to approve a payment: ${card.title}, ${fee(card.feeUnits)}, code ${card.code}]`;
    case "task":
      return `[app: post_task posted open task ${card.task} on Arkiv for ${card.skill} ("${card.title}"), taking bids until ${card.closesAt}; read them with check_bids]`;
    case "payment":
      return `[app: hire_agent scheduled ${fee(card.feeUnits)} to ${card.title} on Hedera (schedule ${card.scheduleId}), running at ${card.executesAt} unless the user cancelled it]`;
    case "hired":
      return `[app: hire_agent hired ${card.title} for ${card.skill}, paid ${fee(card.feeUnits)}, tx ${card.hederaTx}: ${card.summary}]`;
    case "watch":
      return `[app: ${card.title} was hired to watch this fare (watch ${card.watchId}); whether it's still watching shows on its live card, and the app posts its alerts in this chat by itself]`;
  }
}

export const withCardNotes = (text: string, cards: Card[]) =>
  [text, ...cards.map(cardNote)].filter(Boolean).join("\n");
