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
import type { Chat, MandateRow } from "../db/schema";
import { grantSubMandate, recordSubHires, vetSubcontract } from "./delegate";
import type { HiringEnv } from "./env";
import {
  chatRemaining,
  covers,
  currentMandate,
  limitCard,
  type Payee,
  PER_PAYMENT_CAP,
} from "./mandates";
import { saveHire } from "./record";

/** What hiring needs to know about a chat. */
export type ChatLike = Pick<Chat, "id" | "mode" | "limitUnits">;

const QUOTE_TTL_MS = 170_000;
const usdc = (u: bigint) => (Number(u) / 1e6).toFixed(2); // agents hold a quote for 3 minutes; stop a little earlier

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
interface Approval {
  ref: string;
  approved: boolean;
  humanAt?: number; // when a World ID check for this exact approval passed
}

const HUMAN_FRESH_MS = 5 * 60_000; // a human check unlocks its payment for 5 minutes

/** `requireHuman`: approvals in "ask" chats need a fresh World ID check (when configured). */
export function hiringService(db: Db, env: HiringEnv, opts: { requireHuman?: boolean } = {}) {
  const held = new Map<string, Held[]>(); // chatId → quotes, newest last
  const approvals = new Map<string, Map<string, Approval>>();
  const human = (a: Approval) =>
    !opts.requireHuman || (!!a.humanAt && Date.now() - a.humanAt < HUMAN_FRESH_MS);
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
      const qd = await quoteDeps();
      const round = await collectQuotes(skill, task, input, qd);
      // Agents that hire others name who they'll pay; only quotes we can vet are offered.
      const options = [];
      for (const o of round.options) {
        if (!o.subcontract) options.push(o);
        else {
          const sub = await vetSubcontract(qd.arkiv, o.agent, o.subcontract).catch(() => null);
          if (sub) options.push({ ...o, subcontract: sub });
          else round.skipped.push(`${nameOf(o)}: its plan names agents we couldn't verify`);
          for (const p of sub?.payees ?? []) names.set(p.agent.toLowerCase(), p.name);
        }
      }
      round.options = options;
      return { round, refs: this.hold(chat.id, round) };
    },

    /**
     * Keeps a round's offers under short refs (q1, q2…) for a few minutes. An offer already held
     * (an open task's bids are read again and again) keeps its ref and its clock.
     */
    hold(chatId: string, round: QuoteRound) {
      const now = live(chatId);
      const refs = round.options.map(
        (option) =>
          now.find((h) => h.option.key === option.key) ?? {
            ref: `q${nextRef++}`,
            round,
            option,
            at: Date.now(),
          },
      );
      held.set(chatId, [...now, ...refs.filter((r) => !now.includes(r))]);
      for (const o of round.options) names.set(o.agent.toLowerCase(), nameOf(o));
      return refs;
    },

    /** What a ref points at, while it's live (for recording an open task's award). */
    held(chatId: string, ref: string) {
      const h = find(chatId, ref);
      return h ? { round: h.round, option: h.option } : null;
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
      for (const h of live(chatId)) {
        add(h.option.agent);
        for (const p of h.option.subcontract?.payees ?? []) add(p.agent);
      }
      for (const p of current?.payees ?? []) if (!seen.has(p.toLowerCase())) add(p);
      return [...seen.values()];
    },

    /** True while an approval card's code is waiting for the user's answer. */
    pendingApproval(chatId: string, code: string) {
      const a = approvals.get(chatId)?.get(code);
      return !!a && !a.approved;
    },

    /** A World ID check for this approval passed (validated server-side). */
    markHuman(chatId: string, code: string) {
      const a = approvals.get(chatId)?.get(code);
      if (a) a.humanAt = Date.now();
    },

    /** Reads "Approve abc123" / "Decline abc123" in what the user sent. */
    noteUserMessage(chatId: string, text: string) {
      for (const m of text.matchAll(/\b(approve|decline)\s+([a-z0-9]{6})\b/gi)) {
        const entry = approvals.get(chatId)?.get((m[2] ?? "").toLowerCase());
        // "Approve" only counts once the human check passed; "Decline" always counts.
        if (entry) entry.approved = (m[1] ?? "").toLowerCase() === "approve" && human(entry);
      }
    },

    async hire(chat: ChatLike, ref: string, reason: string, label: string): Promise<HireOutcome> {
      const h = find(chat.id, ref);
      if (!h)
        return {
          status: "refused",
          reason: `quote ${ref} expired or doesn't exist; get fresh quotes`,
        };
      const sub = h.option.subcontract;
      const cost = h.option.feeUnits + BigInt(sub?.budgetUnits ?? 0);
      const mandate = await currentMandate(db, chat.id);
      const needed = [h.option.agent, ...(sub?.payees.map((p) => p.agent) ?? [])];
      if (!needed.every((a) => covers(mandate, a))) {
        const left = await chatRemaining(db, chat);
        if (left < cost)
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
        const ok = [...mine.entries()].find(([, a]) => a.ref === ref && a.approved && human(a));
        if (!ok) {
          const code = randomBytes(3).toString("hex");
          mine.set(code, { ref, approved: false });
          return {
            status: "needs_approval",
            card: {
              type: "approval",
              code,
              title: `Hire ${h.option.title.split(" — ")[0]}`,
              detail: sub
                ? `${h.option.note}. It also gets up to ${usdc(BigInt(sub.budgetUnits))} USDC from this limit to pay ${sub.payees.map((p) => p.name).join(" and ")}.`
                : h.option.note,
              feeUnits: h.option.feeUnits.toString(),
              ...(opts.requireHuman ? { human: true } : {}),
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
        // A planner gets its own slice of this limit, granted on Hedera before it's paid.
        const delegation = sub ? await grantSubMandate(env, m, h.option.agent, sub) : undefined;
        if (delegation)
          await env.log?.write({
            kind: "agentnet.mandate.delegated",
            mandateId: delegation.mandateId,
            parentId: m.mandateId.toString(),
            agent: h.option.agent,
            budget: delegation.budget.toString(),
            payees: delegation.payees,
          });
        const hire = await buy(
          h.round,
          h.option,
          label,
          deps,
          reason,
          delegation && { mandateId: delegation.mandateId, payer: delegation.payer }, // sent as JSON
        );
        held.set(
          chat.id,
          live(chat.id).filter((x) => x.round !== h.round),
        ); // that job is done
        const log = await saveHire(db, env, {
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
        const subHires = delegation
          ? await recordSubHires(db, env, chat.id, delegation, hire.result)
          : undefined;
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
            log,
            subMandateId: delegation?.mandateId,
            subHires,
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
