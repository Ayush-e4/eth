import { and, count, eq, gt, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import { chats, hires, mandates, messages } from "../db/schema";

/**
 * Daily allowances for demo accounts. Demo hires are paid by one shared test wallet, every new
 * spending limit costs it network fees, and every message costs Claude tokens. Anyone can open a
 * demo account in one click, so per-account limits alone are easy to dodge: the shared wallet
 * also has a daily total. Wallet users pay their own way and aren't limited here.
 * Web2 analogy: a free tier with per-account limits and an overall budget.
 */
export interface DemoQuotas {
  messagesPerUser: number;
  hiresPerUser: number;
  limitsPerUser: number;
  limitsPerDay: number; // all demo accounts together
  feeUnitsPerDay: bigint; // agent fees the demo wallet may pay in a day, all accounts together
}

export function loadDemoQuotas(e: NodeJS.ProcessEnv = process.env): DemoQuotas {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    messagesPerUser: n(e.DEMO_MESSAGES_PER_DAY, 40),
    hiresPerUser: n(e.DEMO_HIRES_PER_DAY, 5),
    limitsPerUser: n(e.DEMO_LIMITS_PER_DAY, 3),
    limitsPerDay: n(e.DEMO_LIMITS_TOTAL_PER_DAY, 40),
    feeUnitsPerDay: BigInt(Math.round(n(e.DEMO_FEES_TOTAL_PER_DAY_USDC, 3) * 1e6)),
  };
}

const DAY_MS = 86_400_000;
const NEXT =
  "Sign in with MetaMask to keep going with your own test wallet, or come back tomorrow.";

export function demoQuotas(db: Db, q: DemoQuotas = loadDemoQuotas()) {
  const since = () => new Date(Date.now() - DAY_MS); // a rolling 24 hours

  async function usage(userId: string) {
    const [msgs] = await db
      .select({ n: count() })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(eq(chats.userId, userId), eq(messages.role, "user"), gt(messages.createdAt, since())),
      );
    const [mine] = await db
      .select({ n: count() })
      .from(hires)
      .innerJoin(chats, eq(chats.id, hires.chatId))
      .where(and(eq(chats.userId, userId), gt(hires.createdAt, since())));
    const [limits] = await db
      .select({ n: count() })
      .from(mandates)
      .innerJoin(chats, eq(chats.id, mandates.chatId))
      .where(
        and(eq(chats.userId, userId), eq(mandates.demo, true), gt(mandates.createdAt, since())),
      );
    return { messages: msgs?.n ?? 0, hires: mine?.n ?? 0, limits: limits?.n ?? 0 };
  }

  async function wallet() {
    const [fees] = await db
      .select({ units: sum(hires.feeUnits) })
      .from(hires)
      .innerJoin(mandates, eq(mandates.mandateId, hires.mandateId))
      .where(and(eq(mandates.demo, true), gt(hires.createdAt, since())));
    const [limits] = await db
      .select({ n: count() })
      .from(mandates)
      .where(and(eq(mandates.demo, true), gt(mandates.createdAt, since())));
    return { feeUnits: BigInt(fees?.units ?? 0), limits: limits?.n ?? 0 };
  }

  return {
    quotas: q,

    /** What a demo account has left today (shown on the Wallet page). */
    async left(userId: string) {
      const u = await usage(userId);
      return {
        messages: Math.max(0, q.messagesPerUser - u.messages),
        hires: Math.max(0, q.hiresPerUser - u.hires),
        limits: Math.max(0, q.limitsPerUser - u.limits),
        quotas: { ...q, feeUnitsPerDay: q.feeUnitsPerDay.toString() },
      };
    },

    /** Null if this demo account may send a message now, else why not. */
    async canSend(userId: string) {
      const u = await usage(userId);
      return u.messages < q.messagesPerUser
        ? null
        : `This demo account has used today's ${q.messagesPerUser} messages. ${NEXT}`;
    },

    async canCreateLimit(userId: string) {
      const [u, w] = await Promise.all([usage(userId), wallet()]);
      if (u.limits >= q.limitsPerUser)
        return `This demo account has set ${q.limitsPerUser} spending limits today, the most for one day. ${NEXT}`;
      if (w.limits >= q.limitsPerDay)
        return `The demo wallet has set up as many limits as it can today. ${NEXT}`;
      return null;
    },

    /** Checked before a demo hire pays: this account's count, and the shared wallet's budget. */
    async canHire(chatId: string, feeUnits: bigint) {
      const [chat] = await db
        .select({ userId: chats.userId })
        .from(chats)
        .where(eq(chats.id, chatId));
      if (!chat) return "chat not found";
      const [u, w] = await Promise.all([usage(chat.userId), wallet()]);
      if (u.hires >= q.hiresPerUser)
        return `this demo account has used today's ${q.hiresPerUser} paid hires. ${NEXT}`;
      if (w.feeUnits + feeUnits > q.feeUnitsPerDay)
        return `the shared demo wallet has spent today's budget for agent fees. ${NEXT}`;
      return null;
    },
  };
}

export type DemoQuotaCheck = ReturnType<typeof demoQuotas>;
