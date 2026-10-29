import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, type User, users } from "../db/schema";

export const SESSION_COOKIE = "eth_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Starts a session; returns the raw token for the cookie (only its hash is stored). */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: hash(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

/** The signed-in user for a cookie token, or null if missing, unknown or expired. */
export async function userForToken(
  db: Db,
  token: string | undefined,
  now = new Date(),
): Promise<User | null> {
  if (!token) return null;
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function endSession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hash(token)));
}
