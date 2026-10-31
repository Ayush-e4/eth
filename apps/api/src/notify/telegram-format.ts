import type { Card } from "@eth/shared";

const usdc = (units: string) => `${(Number(units) / 1e6).toFixed(2)} USDC`;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Markdown from the concierge, as plain text Telegram shows well. */
export function plain(md: string) {
  return md
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .trim();
}

type Markup =
  | { keyboard: { text: string }[][]; one_time_keyboard: true; resize_keyboard: true }
  | { inline_keyboard: { text: string; url: string }[][] }
  | { remove_keyboard: true };

/**
 * A concierge reply as one Telegram message. Choices (quotes, options, approvals) become buttons
 * that send their reply as the next message, just like tapping them in the app. Anything that
 * needs Face ID (a spending limit) opens the chat in the app.
 */
export function telegramReply(text: string, cards: Card[], link: string) {
  const lines: string[] = [plain(text)];
  const choices: string[] = [];
  let needsApp: string | null = null;
  for (const c of cards) {
    if (c.type === "quotes") {
      lines.push(`Quotes for ${c.skill}:`);
      c.quotes.forEach((q, i) => {
        const total = q.totalInr !== undefined ? `${inr(q.totalInr)} · ` : "";
        lines.push(
          `${i + 1}. ${q.title}: ${total}fee ${usdc(q.feeUnits)}${q.track ? ` · ${q.track}` : ""}`,
        );
        choices.push(q.reply);
      });
    } else if (c.type === "options") {
      lines.push(c.question);
      for (const o of c.options) choices.push(o.reply);
    } else if (c.type === "agents") {
      lines.push(
        ...c.agents.map((a) => `· ${a.name} (${a.skill}): ${a.title}, ${usdc(a.priceUnits)} a job`),
      );
    } else if (c.type === "limit") {
      lines.push(`To pay agents here, approve a limit of up to ${usdc(c.budgetUnits)} in the app.`);
      needsApp = "Approve with Face ID";
    } else if (c.type === "approval") {
      lines.push(`${c.title}: ${c.detail}`);
      if (c.human) needsApp = "Approve in AgentNet";
      else choices.push(`Approve ${c.code}`, `Decline ${c.code}`);
    } else if (c.type === "hired") {
      lines.push(`Done: ${c.title} did the ${c.skill} job, paid ${usdc(c.feeUnits)}.`);
      lines.push(`Payment proof: https://hashscan.io/testnet/transaction/${c.hederaTx}`);
    } else if (c.type === "payment") {
      lines.push(
        `${usdc(c.feeUnits)} to ${c.title} pays at ${new Date(c.executesAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} (you can cancel it in the app until then).`,
      );
    } else if (c.type === "watch") {
      lines.push(`Watching: ${c.title}. I'll tell you here when something changes.`);
    } else if (c.type === "task") {
      lines.push(`Open task posted: ${c.title}. Agents can bid on it now.`);
    }
  }

  const httpsLink = link.startsWith("https://");
  let markup: Markup = { remove_keyboard: true };
  if (choices.length)
    markup = {
      keyboard: choices.slice(0, 8).map((t) => [{ text: t.slice(0, 120) }]),
      one_time_keyboard: true,
      resize_keyboard: true,
    };
  else if (needsApp && httpsLink) markup = { inline_keyboard: [[{ text: needsApp, url: link }]] };
  if (needsApp && (choices.length || !httpsLink)) lines.push(`Open it here: ${link}`);
  return { text: lines.filter(Boolean).join("\n\n").slice(0, 4000), markup };
}
