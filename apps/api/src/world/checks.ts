import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { humanChecks as table, users } from "../db/schema";
import type { WorldClient } from "./oidc";

export type CheckStatus = "waiting" | "verified" | "denied" | "expired" | "failed" | "mismatch";

/** One human check, bound to the user, the chat and the exact payment approval it unlocks. */
export interface HumanCheck {
  id: string;
  userId: string;
  chatId: string;
  code: string; // the approval card's code
  userCode: string;
  link: string; // where the person approves (World ID page)
  expiresAt: number; // ms
  status: CheckStatus;
  reason?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs World ID checks for payment approvals. The device code stays here (never in the browser
 * or the model); we poll World until the person approves, denies, or time runs out, then check
 * the signed result and that it's the World ID linked to this account. Only then is the
 * approval marked human-verified. Anything else leaves it unpaid.
 * Checks are kept in the database: after a restart, `resume()` picks up the waiting ones.
 */
export function humanChecks(
  db: Db,
  world: WorldClient,
  onVerified: (chatId: string, code: string) => unknown,
  wait: (ms: number) => Promise<void> = sleep,
) {
  const toCheck = (r: typeof table.$inferSelect): HumanCheck => ({
    id: r.id,
    userId: r.userId,
    chatId: r.chatId,
    code: r.code,
    userCode: r.userCode,
    link: r.link,
    expiresAt: r.expiresAt.getTime(),
    status: r.status as CheckStatus,
    ...(r.reason ? { reason: r.reason } : {}),
  });

  /** First check links the World ID to the account; later checks must be that same World ID. */
  async function link(userId: string, iss: string, sub: string): Promise<string | null> {
    const [me] = await db.select().from(users).where(eq(users.id, userId));
    if (!me) return "account not found";
    if (me.worldSub)
      return me.worldIss === iss && me.worldSub === sub ? null : "a different World ID";
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.worldIss, iss), eq(users.worldSub, sub)));
    if (taken) return "this World ID is linked to another account";
    const linked = await db
      .update(users)
      .set({ worldIss: iss, worldSub: sub })
      .where(and(eq(users.id, userId), isNull(users.worldSub)))
      .returning({ id: users.id })
      .catch(() => []); // unique index: someone else linked it first
    return linked.length ? null : "couldn't link this World ID";
  }

  async function run(c: HumanCheck, deviceCode: string, startedAtS: number, interval: number) {
    let every = interval * 1000;
    const end = async (status: CheckStatus, reason?: string) => {
      Object.assign(c, { status, reason });
      await db
        .update(table)
        .set({ status, reason: reason ?? null })
        .where(eq(table.id, c.id));
    };
    while (Date.now() < c.expiresAt) {
      await wait(every);
      const r = await world.poll(deviceCode);
      if (r.status === "pending") continue;
      if (r.status === "slow_down") {
        every += 5000;
        continue;
      }
      if (r.status !== "done") return end(r.status, r.error);
      try {
        const v = await world.verify(r.idToken, startedAtS);
        const problem = await link(c.userId, v.iss, v.sub);
        if (problem) return end("mismatch", problem);
        await end("verified");
        await onVerified(c.chatId, c.code);
      } catch (err) {
        end("failed", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    return end("expired", "the check timed out");
  }

  const go = (c: HumanCheck, deviceCode: string, startedAtS: number, interval: number) =>
    void run(c, deviceCode, startedAtS, interval).catch(async (err) => {
      Object.assign(c, { status: "failed", reason: String(err) });
      await db
        .update(table)
        .set({ status: "failed", reason: String(err) })
        .where(eq(table.id, c.id))
        .catch(() => {});
    });

  return {
    async start(userId: string, chatId: string, code: string): Promise<HumanCheck> {
      const startedAtS = Math.floor(Date.now() / 1000);
      const d = await world.start();
      const c: HumanCheck = {
        id: randomUUID(),
        userId,
        chatId,
        code,
        userCode: d.userCode,
        link: d.verificationUriComplete ?? d.verificationUri,
        expiresAt: Date.now() + d.expiresIn * 1000,
        status: "waiting",
      };
      await db.insert(table).values({
        ...c,
        expiresAt: new Date(c.expiresAt),
        deviceCode: d.deviceCode,
        intervalS: d.interval,
        startedAtS,
      });
      go(c, d.deviceCode, startedAtS, d.interval);
      return c;
    },

    /** Someone else's check is simply "not found". */
    async get(id: string, userId: string): Promise<HumanCheck | null> {
      if (![id, userId].every((v) => UUID.test(v))) return null; // ids come from the URL
      const [r] = await db
        .select()
        .from(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)));
      return r ? toCheck(r) : null;
    },

    /** After a restart: keep polling the checks that were still waiting; the rest timed out. */
    async resume() {
      const waiting = await db.select().from(table).where(eq(table.status, "waiting"));
      for (const r of waiting) {
        if (r.expiresAt.getTime() > Date.now())
          go(toCheck(r), r.deviceCode, r.startedAtS, r.intervalS);
        else
          await db
            .update(table)
            .set({ status: "expired", reason: "the check timed out" })
            .where(eq(table.id, r.id));
      }
      return waiting.length;
    },
  };
}

export type HumanChecks = ReturnType<typeof humanChecks>;
