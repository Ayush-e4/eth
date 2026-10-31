import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
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

/**
 * Runs World ID checks for payment approvals. The device code stays here (never in the browser
 * or the model); we poll World until the person approves, denies, or time runs out, then check
 * the signed result and that it's the World ID linked to this account. Only then is the
 * approval marked human-verified. Anything else leaves it unpaid.
 */
export function humanChecks(
  db: Db,
  world: WorldClient,
  onVerified: (chatId: string, code: string) => void,
  wait: (ms: number) => Promise<void> = sleep,
) {
  const checks = new Map<string, HumanCheck>();

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
    const end = (status: CheckStatus, reason?: string) => Object.assign(c, { status, reason });
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
        end("verified");
        onVerified(c.chatId, c.code);
      } catch (err) {
        end("failed", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    end("expired", "the check timed out");
  }

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
      checks.set(c.id, c);
      void run(c, d.deviceCode, startedAtS, d.interval).catch((err) =>
        Object.assign(c, { status: "failed", reason: String(err) }),
      );
      return c;
    },

    /** Someone else's check is simply "not found". */
    get(id: string, userId: string): HumanCheck | null {
      const c = checks.get(id);
      return c && c.userId === userId ? c : null;
    },
  };
}

export type HumanChecks = ReturnType<typeof humanChecks>;
