import { randomBytes } from "node:crypto";

interface Approval {
  ref: string;
  agent: string; // a fresh quote from the same agent at no higher fee keeps the approval
  feeUnits: bigint;
  approved: boolean;
  humanAt?: number; // when a World ID check for this exact approval passed
}

const HUMAN_FRESH_MS = 5 * 60_000; // a human check unlocks its payment for 5 minutes

/**
 * "Ask first" approvals: one code per payment the concierge wants to make. With `requireHuman`,
 * an approval counts only after a World ID check for it passed, within 5 minutes. One approval
 * pays once.
 */
export function approvalBook(requireHuman = false) {
  const book = new Map<string, Map<string, Approval>>(); // chatId → code → approval
  const human = (a: Approval) =>
    !requireHuman || (!!a.humanAt && Date.now() - a.humanAt < HUMAN_FRESH_MS);
  const of = (chatId: string) => {
    const mine = book.get(chatId) ?? new Map<string, Approval>();
    book.set(chatId, mine);
    return mine;
  };

  return {
    requireHuman,

    /** Takes (uses up) an approval for this offer, if the user gave one. */
    take(chatId: string, ref: string, agent: string, feeUnits: bigint) {
      const mine = of(chatId);
      // A quote can lapse during a slow human check; the approval was for this agent and fee.
      const same = (a: Approval) => a.ref === ref || (a.agent === agent && feeUnits <= a.feeUnits);
      const ok = [...mine.entries()].find(([, a]) => same(a) && a.approved && human(a));
      if (ok) mine.delete(ok[0]);
      return !!ok;
    },

    /** Asks for one: returns the code the card shows. */
    ask(chatId: string, ref: string, agent: string, feeUnits: bigint) {
      const code = randomBytes(3).toString("hex");
      of(chatId).set(code, { ref, agent, feeUnits, approved: false });
      return code;
    },

    pending(chatId: string, code: string) {
      const a = book.get(chatId)?.get(code);
      return !!a && !a.approved;
    },

    markHuman(chatId: string, code: string) {
      const a = book.get(chatId)?.get(code);
      if (a) a.humanAt = Date.now();
    },

    /** Reads "Approve abc123" / "Decline abc123" in what the user sent. */
    note(chatId: string, text: string) {
      for (const m of text.matchAll(/\b(approve|decline)\s+([a-z0-9]{6})\b/gi)) {
        const entry = book.get(chatId)?.get((m[2] ?? "").toLowerCase());
        // "Approve" only counts once the human check passed; "Decline" always counts.
        if (entry) entry.approved = (m[1] ?? "").toLowerCase() === "approve" && human(entry);
      }
    },
  };
}
