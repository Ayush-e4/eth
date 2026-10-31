import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describeTrack } from "@eth/agents/hiring";
import type { Card, ConciergeEvent } from "@eth/shared";
import { z } from "zod";
import type { ChatLike, HiringService } from "../hiring/service";
import type { Market } from "./market";

const skill = z.string().regex(/^[a-z0-9_.-]{1,64}$/);
const trim = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Tools that spend: they only work through the hiring service, which enforces the chat's
 * mandate and approvals in code. Cards tell the user what happened; results tell Claude.
 */
export function hireTools(
  hiring: HiringService,
  market: Market,
  chat: ChatLike,
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
  afterHire: (
    held: NonNullable<Awaited<ReturnType<HiringService["held"]>>>,
  ) => Promise<void> = async () => {},
) {
  const agentInput = betaZodTool({
    name: "agent_input",
    description:
      "Get the JSON Schema of the `input` that agents with this skill accept. Call it before get_quotes so the input is right.",
    inputSchema: z.object({ skill }),
    run: async ({ skill }) => {
      const pinned = chat.agentAddress?.toLowerCase();
      for (const a of await market.agents(skill)) {
        if (pinned && a.agent.toLowerCase() !== pinned) continue; // a chat with one agent
        const res = await fetch(a.endpoint, { signal: AbortSignal.timeout(5000) }).catch(
          () => null,
        );
        if (!res?.ok) continue;
        const profile = (await res.json().catch(() => null)) as { inputSchema?: unknown } | null;
        if (profile?.inputSchema) return trim(profile.inputSchema, 3000);
      }
      return `No ${skill} agent is reachable right now.`;
    },
  });

  const getQuotes = betaZodTool({
    name: "get_quotes",
    description:
      "Ask every market agent with this skill for a quote on `input` (free, no payment). Shows the user a quotes card and returns quote refs (q1, q2…) ranked by total cost. Quotes expire in about 3 minutes.",
    inputSchema: z.object({ skill, input: z.record(z.string(), z.unknown()) }),
    run: async ({ skill, input }) => {
      emit({ type: "status", label: `Getting ${skill} quotes` });
      const { round, refs } = await hiring.quotes(chat, skill, input);
      if (refs.length) {
        show({
          type: "quotes",
          skill,
          reason: round.bestReason,
          quotes: refs.map(({ ref, option: o }) => ({
            key: ref,
            title: o.title.split(" — ")[0] ?? o.title,
            note: o.note,
            feeUnits: o.feeUnits.toString(),
            itemTotal: o.itemTotal,
            itemCurrency: o.itemCurrency,
            totalInr: o.priced?.totalInr,
            track: describeTrack(o.track),
            reply: `Go with ${o.title.split(" — ")[0]} (${ref})`,
          })),
        });
      }
      return JSON.stringify({
        quotes: refs.map(({ ref, option: o }) => ({
          ref,
          agent: o.title,
          note: o.note,
          feeUsdc: (Number(o.feeUnits) / 1e6).toFixed(2),
          trackRecord: describeTrack(o.track),
          // The rupee split is computed for you (today's rates); Claude's own maths has slipped.
          ...(o.priced
            ? {
                itemInr: Math.round(o.priced.itemInr),
                feeInr: Math.round(o.priced.feeInr),
                totalInr: Math.round(o.priced.totalInr),
              }
            : {}),
        })),
        amounts:
          "Quote itemInr, feeInr and totalInr exactly as given; never convert currencies yourself.",
        best: refs[0]?.ref ?? null,
        why: round.bestReason,
        problems: round.skipped.map((s) => trim(s, 400)),
      });
    },
  });

  const hireAgent = betaZodTool({
    name: "hire_agent",
    description:
      "Hire and pay the agent behind a quote ref. Only when the user wants it done. If the chat has no spending limit for that agent yet, or the chat asks before each payment, this shows the user a card and returns what's needed: then stop and wait for them.",
    inputSchema: z.object({
      quote: z
        .string()
        .regex(/^q\d+$/)
        .describe("a ref from get_quotes, e.g. q1"),
      reason: z.string().max(300).describe("why this quote, in one line"),
    }),
    run: async ({ quote, reason }) => {
      emit({ type: "status", label: "Hiring" });
      const held = await hiring.held(chat.id, quote); // a hire drops its refs, so read it first
      const out = await hiring.hire(chat, quote, reason, `booked from an AgentNet chat`, (card) => {
        show(card); // the payment waits out its undo window; the user can cancel it
        emit({ type: "status", label: "Paying when the undo window ends" });
      });
      if ("card" in out) show(out.card);
      if (out.status === "hired") for (const c of out.more ?? []) show(c); // e.g. a fare watch
      if (out.status === "hired" && held) await afterHire(held).catch(() => {}); // e.g. award an open task
      if (out.status === "hired")
        return JSON.stringify({
          status: "hired",
          paid: out.card.hederaTx,
          result: trim(out.result, 2500),
        });
      if (out.status === "needs_limit")
        return "Not paid yet: the user must approve a spending limit for this chat (card shown). Stop here and wait; when they say it's approved, call hire_agent again.";
      if (out.status === "needs_approval")
        return out.card.human
          ? `Not paid yet: this chat asks before every payment, and approving needs a World ID check on the card (code ${out.card.code}). Tell the user to tap "Approve with World ID" on the card; typing "Approve" alone isn't enough. Stop and wait.`
          : `Not paid yet: this chat asks before every payment. The user sees an approval card (code ${out.card.code}). Stop and wait for "Approve ${out.card.code}".`;
      if (out.status === "pending")
        return `Paid, or being paid: ${out.reason}. Tell the user in one line; don't hire again for this.`;
      if (/unknown_or_expired_quote/.test(out.reason))
        return "Not hired, nothing paid: the agent no longer holds that quote (it expired, or the agent restarted). Call get_quotes again; if the same agent quotes the same fee or less for the same thing, hire that new quote without asking again.";
      if (/payment_cancelled_in_undo_window/.test(out.reason))
        return "Not hired: the user cancelled the payment in its undo window. Nothing was paid and the agent did no work. Say so in one line; don't retry unless they ask.";
      return `Not hired: ${out.reason}`;
    },
  });

  return { agentInput, getQuotes, hireAgent };
}
