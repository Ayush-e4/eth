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
import type { DemoQuotaCheck } from "../demo/quotas";
import { approvalBook } from "./approvals";
import { grantSubMandate, vetSubcontract } from "./delegate";
import type { HiringEnv } from "./env";
import {
  chatRemaining,
  covers,
  currentMandate,
  limitCard,
  type Payee,
  PER_PAYMENT_CAP,
} from "./mandates";
import type { PendingHires } from "./pending";
import { quoteRefs } from "./quote-refs";
import { finishHire } from "./record";
import type { Reputation } from "./reputation";
import type { UndoWindows } from "./undo";

/** What hiring needs to know about a chat. */
export type ChatLike = Pick<Chat, "id" | "mode" | "limitUnits"> & {
  agentAddress?: string | null; // a chat with one agent: only it is asked and paid
};

const usdc = (u: bigint) => (Number(u) / 1e6).toFixed(2);

export type HireOutcome =
  | { status: "hired"; card: Extract<Card, { type: "hired" }>; result: unknown }
  | { status: "needs_limit"; card: Extract<Card, { type: "limit" }> }
  | { status: "needs_approval"; card: Extract<Card, { type: "approval" }> }
  | { status: "pending"; reason: string } // paid (or paying); the result is posted when it's in
  | { status: "refused"; reason: string };

/**
 * Hiring for chats. Quotes are free and kept a few minutes under short refs; paying needs the
 * chat's mandate on Hedera, and in "ask" chats a one-time approval code the user sent. Those
 * rules live here in code: the concierge can ask for a hire, it can't skip them.
 */
/** `requireHuman`: approvals in "ask" chats need a fresh World ID check (when configured). */
export function hiringService(
  db: Db,
  env: HiringEnv,
  opts: {
    requireHuman?: boolean;
    reputation?: Reputation;
    undo?: UndoWindows;
    pending?: PendingHires;
    demo?: DemoQuotaCheck; // daily allowances when the shared demo wallet pays
  } = {},
) {
  const refs = quoteRefs(db);
  const approvals = approvalBook(db, opts.requireHuman);
  const nameOf = (o: QuoteOption) => o.title.split(" — ")[0] ?? o.title;

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
      const round = await collectQuotes(skill, task, input, {
        ...qd,
        ...(chat.agentAddress ? { only: chat.agentAddress } : {}),
      });
      // Agents that hire others name who they'll pay; only quotes we can vet are offered.
      const options = [];
      for (const o of round.options) {
        if (!o.subcontract) options.push(o);
        else {
          const sub = await vetSubcontract(qd.arkiv, o.agent, o.subcontract).catch(() => null);
          if (sub) options.push({ ...o, subcontract: sub });
          else round.skipped.push(`${nameOf(o)}: its plan names agents we couldn't verify`);
        }
      }
      round.options = options;
      return { round, refs: await this.hold(chat.id, round) };
    },

    /** Keeps a round's offers under short refs (q1, q2…) for a few minutes. */
    hold: (chatId: string, round: QuoteRound) => refs.hold(chatId, round),

    /** What a ref points at, while it's live (for recording an open task's award). */
    async held(chatId: string, ref: string) {
      const h = await refs.find(chatId, ref);
      return h ? { round: h.round, option: h.option } : null;
    },

    /** Agents the user would be asked to allow: everyone quoting now, plus those already allowed. */
    async payees(chatId: string, current: MandateRow | null): Promise<Payee[]> {
      const live = await refs.live(chatId);
      const names = new Map<string, string>(); // agent address → name, from the quotes
      for (const h of live) {
        names.set(h.option.agent.toLowerCase(), nameOf(h.option));
        for (const p of h.option.subcontract?.payees ?? [])
          names.set(p.agent.toLowerCase(), p.name);
      }
      const seen = new Map<string, Payee>();
      const add = (agent: string) =>
        seen.set(agent.toLowerCase(), {
          name:
            names.get(agent.toLowerCase()) ??
            current?.payeeNames[agent.toLowerCase()] ??
            `agent ${agent.slice(0, 6)}…${agent.slice(-4)}`,
          agent: agent as `0x${string}`,
        });
      for (const h of live) {
        add(h.option.agent);
        for (const p of h.option.subcontract?.payees ?? []) add(p.agent);
      }
      for (const p of current?.payees ?? []) if (!seen.has(p.toLowerCase())) add(p);
      return [...seen.values()];
    },

    /** True while an approval card's code is waiting for the user's answer. */
    pendingApproval: (chatId: string, code: string) => approvals.pending(chatId, code),
    /** A World ID check for this approval passed (validated server-side). */
    markHuman: (chatId: string, code: string) => approvals.markHuman(chatId, code),
    /** Reads "Approve abc123" / "Decline abc123" in what the user sent. */
    noteUserMessage: (chatId: string, text: string) => approvals.note(chatId, text),

    /** `onScheduled`: an "auto" payment is waiting out its undo window (show it, with Cancel). */
    async hire(
      chat: ChatLike,
      ref: string,
      reason: string,
      label: string,
      onScheduled?: (card: Extract<Card, { type: "payment" }>) => void,
    ): Promise<HireOutcome> {
      const h = await refs.find(chat.id, ref);
      if (!h)
        return {
          status: "refused",
          reason: `quote ${ref} expired or doesn't exist; get fresh quotes`,
        };
      if (chat.agentAddress && h.option.agent.toLowerCase() !== chat.agentAddress.toLowerCase())
        return {
          status: "refused",
          reason: "this chat only works with one agent; that quote is someone else's",
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
        const payees = await this.payees(chat.id, mandate);
        return { status: "needs_limit", card: limitCard(env, left, payees) };
      }
      if (mandate?.demo && opts.demo) {
        const over = await opts.demo.canHire(chat.id, cost);
        if (over) return { status: "refused", reason: `Not hired, nothing paid: ${over}` };
      }
      // "Ask first": one approval, one payment (taken here, or asked for with a card).
      if (
        chat.mode === "ask" &&
        !(await approvals.take(chat.id, ref, h.option.agent, h.option.feeUnits))
      ) {
        const code = await approvals.ask(chat.id, ref, h.option.agent, h.option.feeUnits);
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
            ...(approvals.requireHuman ? { human: true } : {}),
          },
        };
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
          // "Auto" chats pay with an undo window: Hedera holds the payment, the user can cancel.
          ...(chat.mode === "auto" && opts.undo?.seconds
            ? {
                undoSeconds: opts.undo.seconds,
                onSigned: (key: string) =>
                  void opts.undo?.watch(chat.id, key, (s) =>
                    onScheduled?.({
                      type: "payment",
                      scheduleId: s.scheduleId,
                      executesAt: new Date(s.executesAt).toISOString(),
                      title: nameOf(h.option),
                      feeUnits: h.option.feeUnits.toString(),
                    }),
                  ),
              }
            : {}),
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
        // Written down before paying: if this turn can't see the job through, it isn't lost.
        const tracked = await opts.pending?.begin({
          chatId: chat.id,
          mandateId: m.mandateId,
          payer: m.payer,
          round: h.round,
          option: h.option,
          delegation,
          label,
          reason,
        });
        let hire: Awaited<ReturnType<typeof buy>>;
        try {
          hire = await buy(
            h.round,
            h.option,
            label,
            deps,
            reason,
            delegation && { mandateId: delegation.mandateId, payer: delegation.payer }, // as JSON
          );
        } catch (err) {
          if (tracked && (err as Error)?.name === "HirePending") {
            opts.pending?.follow(tracked);
            return {
              status: "pending",
              reason: `${nameOf(h.option)} is still on it; its result will be posted in this chat when it's done`,
            };
          }
          if (tracked) await opts.pending?.end(tracked);
          throw err;
        }
        await refs.drop(chat.id, h.round.task); // that job is done
        const card = await finishHire(db, env, {
          chatId: chat.id,
          mandateId: m.mandateId,
          hire,
          delegation,
          reputation: opts.reputation,
        });
        if (tracked) await opts.pending?.end(tracked);
        return { status: "hired", result: hire.result, card };
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
