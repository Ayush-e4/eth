import {
  type JobView,
  type QuoteOption,
  type QuoteRound,
  readJob,
  recordHire,
} from "@eth/agents/hiring";
import { arkivWriter } from "@eth/arkiv";
import { type Card, decodeJson, encodeJson } from "@eth/shared";
import { and, eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { hires, messages, pendingHires as table } from "../db/schema";
import type { HiringEnv } from "./env";
import { finishHire, type Granted } from "./record";
import type { Reputation } from "./reputation";

type Row = typeof table.$inferSelect;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Read the job back often at first (most finish within minutes), then less, for a day.
const nextCheckMs = (ageMs: number) =>
  ageMs < 5 * 60_000 ? 10_000 : ageMs < 60 * 60_000 ? 60_000 : 10 * 60_000;
const GIVE_UP_MS = 24 * 60 * 60_000;

/** Suppliers answer in JSON; the chat wants its one human line (e.g. "offer no longer available"). */
const readable = (detail = "it failed") =>
  (/"title":"([^"]{3,120})"/.exec(detail)?.[1] ?? detail).slice(0, 160).toLowerCase();

/**
 * Hires the API was paying for when it lost sight of them: a restart, a dropped connection, or an
 * agent still working when the chat turn ended. Each hire is written down before paying; if the
 * turn can't finish it, this reads the job back from the agent (signed by the concierge, the key
 * that signed /work) and posts the outcome to the chat: the result with its card, or the refund.
 */
export function pendingHires(
  db: Db,
  env: HiringEnv,
  d: { reputation?: Reputation; read?: typeof readJob; wait?: typeof sleep } = {},
) {
  const concierge = privateKeyToAccount(env.concierge.key);
  const read = d.read ?? readJob;
  const wait = d.wait ?? sleep;
  const watching = new Set<string>();
  const say = (chatId: string, text: string, cards: Card[] = []) =>
    db.insert(messages).values({ chatId, role: "assistant", text, cards });

  /** The agent delivered: record the hire exactly as the turn would have, then tell the chat. */
  async function delivered(p: Row, job: JobView) {
    const round = decodeJson<QuoteRound>(p.round);
    const option = decodeJson<QuoteOption>(p.option);
    const delegation = p.delegation ? decodeJson<Granted>(p.delegation) : undefined;
    const hederaTx = job.paymentTx ?? "";
    // Already recorded (the turn got there after all)? Then there's nothing to add.
    const [seen] = hederaTx
      ? await db
          .select({ id: hires.id })
          .from(hires)
          .where(and(eq(hires.chatId, p.chatId), eq(hires.hederaTx, hederaTx)))
      : [];
    if (seen) return;
    const hire = await recordHire(
      round,
      option,
      p.label,
      {
        buyerWriter: arkivWriter(env.concierge.key),
        platformWriter: arkivWriter(env.demo.key),
        mandateId: p.mandateId,
        payer: p.payer,
        log: () => {},
        ...(env.release ? { release: env.release } : {}),
      },
      p.reason,
      {
        result: job.result,
        hederaTx,
        payTo: job.payTo,
        ...(job.escrow ? { escrow: job.escrow } : {}),
      },
    );
    const card = await finishHire(db, env, {
      chatId: p.chatId,
      mandateId: p.mandateId,
      hire,
      delegation,
      reputation: d.reputation,
    });
    await say(
      p.chatId,
      `${card.title} finished the job from earlier (${option.note}). Here's what it delivered.`,
      [card],
    );
  }

  /** Follows one hire until the agent says how it ended. */
  async function follow(id: string) {
    if (watching.has(id)) return;
    watching.add(id);
    try {
      for (;;) {
        const [p] = await db.select().from(table).where(eq(table.id, id));
        if (!p) return;
        const age = Date.now() - p.createdAt.getTime();
        const job = await read(p.endpoint, p.quoteKey, concierge).catch(() => undefined);
        if (job === null) {
          // The agent has no job for it: the payment never reached it, so nothing was paid.
          await db.delete(table).where(eq(table.id, id));
          return;
        }
        if (job?.status === "delivered") await delivered(p, job);
        else if (job?.status === "failed") {
          const refund = job.refund?.transaction
            ? `; the fee was refunded (${job.refund.transaction})`
            : job.refund?.failed
              ? `; its refund failed (${job.refund.failed})`
              : "";
          await say(
            p.chatId,
            `${job.agent} couldn't finish the job from earlier: ${readable(job.detail)}${refund}.`,
          );
        } else if (age > GIVE_UP_MS) {
          await say(
            p.chatId,
            `I couldn't reach the agent for the job from earlier for a day. Check Tasks for its payment.`,
          );
        } else {
          await wait(nextCheckMs(age));
          continue;
        }
        await db.delete(table).where(eq(table.id, id));
        return;
      }
    } finally {
      watching.delete(id);
    }
  }

  return {
    /** Written before paying, so the hire can be found again whatever happens next. */
    async begin(h: {
      chatId: string;
      mandateId: bigint;
      payer: string;
      round: QuoteRound;
      option: QuoteOption;
      delegation?: Granted;
      label: string;
      reason: string;
    }) {
      const [row] = await db
        .insert(table)
        .values({
          chatId: h.chatId,
          mandateId: h.mandateId,
          payer: h.payer,
          endpoint: h.option.endpoint,
          quoteKey: h.option.key,
          round: encodeJson(h.round),
          option: encodeJson(h.option),
          delegation: h.delegation ? encodeJson(h.delegation) : null,
          label: h.label,
          reason: h.reason,
        })
        .returning({ id: table.id });
      return row?.id ?? "";
    },

    /** The turn saw it through (or it never got as far as a payment). */
    async end(id: string) {
      await db.delete(table).where(eq(table.id, id));
    },

    /** The turn is giving up waiting: keep following it in the background. */
    follow: (id: string) => void follow(id).catch((err) => console.error("pending hire:", err)),

    /** At startup: follow every hire the last run left open. */
    async resume() {
      const open = await db.select({ id: table.id }).from(table);
      for (const p of open) void follow(p.id).catch((err) => console.error("pending hire:", err));
      return open.length;
    },
  };
}

export type PendingHires = ReturnType<typeof pendingHires>;
