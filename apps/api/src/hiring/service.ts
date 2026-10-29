import { randomBytes } from "node:crypto";
import {
  buy,
  collectQuotes,
  fetchInrRates,
  type HireDeps,
  type QuoteOption,
  type QuoteRound,
} from "@eth/agents/hiring";
import { arkivReader, arkivWriter } from "@eth/arkiv";
import type { Card } from "@eth/shared";
import { createPayingFetch, MirrorResolver } from "@eth/x402";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { type Chat, hires, type MandateRow } from "../db/schema";
import type { HiringEnv } from "./env";
import {
  chatRemaining,
  covers,
  currentMandate,
  limitCard,
  type Payee,
  PER_PAYMENT_CAP,
} from "./mandates";

/** What hiring needs to know about a chat. */
export type ChatLike = Pick<Chat, "id" | "mode" | "limitUnits">;

const QUOTE_TTL_MS = 170_000; // agents hold a quote for 3 minutes; stop a little earlier

interface Held {
  ref: string; // "q1": what the user and Claude use; quote keys are long
  round: QuoteRound;
  option: QuoteOption;
  at: number;
}

export type HireOutcome =
  | { status: "hired"; card: Extract<Card, { type: "hired" }>; result: unknown }
  | { status: "needs_limit"; card: Extract<Card, { type: "limit" }> }
  | { status: "needs_approval"; card: Extract<Card, { type: "approval" }> }
  | { status: "refused"; reason: string };

/**
 * Hiring for chats. Quotes are free and kept a few minutes under short refs; paying needs the
 * chat's mandate on Hedera, and in "ask" chats a one-time approval code the user sent. Those
 * rules live here in code: the concierge can ask for a hire, it can't skip them.
 */
export function hiringService(db: Db, env: HiringEnv) {
  const held = new Map<string, Held[]>(); // chatId → quotes, newest last
  const approvals = new Map<string, Map<string, { ref: string; approved: boolean }>>();
  const names = new Map<string, string>(); // agent address → name, for limit cards
  let nextRef = 1;
  const nameOf = (o: QuoteOption) => o.title.split(" — ")[0] ?? o.title;

  const live = (chatId: string) =>
    (held.get(chatId) ?? []).filter((h) => Date.now() - h.at < QUOTE_TTL_MS);
  const find = (chatId: string, ref: string) => live(chatId).find((h) => h.ref === ref);

  const quoteDeps = async () => ({
    arkiv: arkivReader(),
    evm: env.mc.publicClient,
    registry: env.registry,
    inrRates: await fetchInrRates(),
    log: () => {},
  });

  return {
    async quotes(chat: ChatLike, skill: string, input: unknown) {
      const task = `chat-${chat.id.slice(0, 8)}-${Date.now().toString(36)}`;
      const round = await collectQuotes(skill, task, input, await quoteDeps());
      const added = round.options.map((option) => ({
        ref: `q${nextRef++}`,
        round,
        option,
        at: Date.now(),
      }));
      held.set(chat.id, [...live(chat.id), ...added]);
      for (const o of round.options) names.set(o.agent.toLowerCase(), nameOf(o));
      return { round, refs: added };
    },

    /** Agents the user would be asked to allow: everyone quoting now, plus those already allowed. */
    payees(chatId: string, current: MandateRow | null): Payee[] {
      const seen = new Map<string, Payee>();
      const add = (agent: string) =>
        seen.set(agent.toLowerCase(), {
          name:
            names.get(agent.toLowerCase()) ??
            current?.payeeNames[agent.toLowerCase()] ??
            `agent ${agent.slice(0, 6)}…${agent.slice(-4)}`,
          agent: agent as `0x${string}`,
        });
      for (const h of live(chatId)) add(h.option.agent);
      for (const p of current?.payees ?? []) if (!seen.has(p.toLowerCase())) add(p);
      return [...seen.values()];
    },

    /** Reads "Approve abc123" / "Decline abc123" in what the user sent. */
    noteUserMessage(chatId: string, text: string) {
      for (const m of text.matchAll(/\b(approve|decline)\s+([a-z0-9]{6})\b/gi)) {
        const entry = approvals.get(chatId)?.get((m[2] ?? "").toLowerCase());
        if (entry) entry.approved = (m[1] ?? "").toLowerCase() === "approve";
      }
    },

    async hire(chat: ChatLike, ref: string, reason: string, label: string): Promise<HireOutcome> {
      const h = find(chat.id, ref);
      if (!h)
        return {
          status: "refused",
          reason: `quote ${ref} expired or doesn't exist; get fresh quotes`,
        };
      const mandate = await currentMandate(db, chat.id);
      if (!covers(mandate, h.option.agent)) {
        const left = await chatRemaining(db, chat);
        if (left < h.option.feeUnits)
          return {
            status: "refused",
            reason:
              "this chat's spending limit is used up; the user can raise it with the pill under the message box",
          };
        return { status: "needs_limit", card: limitCard(env, left, this.payees(chat.id, mandate)) };
      }
      if (chat.mode === "ask") {
        const mine = approvals.get(chat.id) ?? new Map();
        approvals.set(chat.id, mine);
        const ok = [...mine.entries()].find(([, a]) => a.ref === ref && a.approved);
        if (!ok) {
          const code = randomBytes(3).toString("hex");
          mine.set(code, { ref, approved: false });
          return {
            status: "needs_approval",
            card: {
              type: "approval",
              code,
              title: `Hire ${h.option.title.split(" — ")[0]}`,
              detail: h.option.note,
              feeUnits: h.option.feeUnits.toString(),
            },
          };
        }
        mine.delete(ok[0]); // one approval, one payment
      }
      const m = mandate as MandateRow;
      const deps: HireDeps = {
        ...(await quoteDeps()),
        buyerWriter: arkivWriter(env.concierge.key),
        platformWriter: arkivWriter(env.demo.key),
        payingFetch: createPayingFetch({
          agent: privateKeyToAccount(env.concierge.key),
          mandateId: m.mandateId,
          payer: m.payer,
          executor: env.registryId,
          executorEvm: env.registry,
          chainId: env.mc.chain.id,
          resolver: new MirrorResolver(env.mirrorUrl),
          maxAmount: PER_PAYMENT_CAP,
        }),
        mandateId: m.mandateId,
        payer: m.payer,
      };
      try {
        const hire = await buy(h.round, h.option, label, deps, reason);
        held.set(
          chat.id,
          live(chat.id).filter((x) => x.round !== h.round),
        ); // that job is done
        await db.insert(hires).values({
          chatId: chat.id,
          mandateId: m.mandateId,
          skill: hire.skill,
          agent: hire.agent,
          title: hire.agentTitle,
          feeUnits: hire.feeUnits,
          hederaTx: hire.hederaTx,
          jobKey: hire.jobKey,
          result: hire.result,
        });
        return {
          status: "hired",
          result: hire.result,
          card: {
            type: "hired",
            skill: hire.skill,
            title: hire.agentTitle.split(" — ")[0] ?? hire.agentTitle,
            summary: hire.quoteNote,
            feeUnits: hire.feeUnits.toString(),
            hederaTx: hire.hederaTx,
            jobKey: hire.jobKey,
          },
        };
      } catch (err) {
        return {
          status: "refused",
          reason: (err instanceof Error ? err.message : String(err)).slice(0, 400),
        };
      }
    },
  };
}

export type HiringService = ReturnType<typeof hiringService>;
