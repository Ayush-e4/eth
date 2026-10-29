import { and, eq, gt, isNull } from "drizzle-orm";
import { getAddress, type Hex, verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { HEDERA_TESTNET_CHAIN_ID } from "../config";
import type { Db } from "../db/client";
import { authNonces, type User, users } from "../db/schema";

export const NONCE_TTL_MS = 10 * 60 * 1000; // a sign-in code is good for 10 minutes

/** Hands out a one-time code the browser puts into the message MetaMask signs. */
export async function issueNonce(db: Db, now = new Date()): Promise<string> {
  const nonce = generateSiweNonce();
  await db.insert(authNonces).values({ nonce, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) });
  return nonce;
}

export class SignInError extends Error {}

/**
 * Checks a Sign-In with Ethereum message and its signature, uses up its nonce, and returns
 * the user (created on first sign-in). Throws SignInError with a reason on any failure.
 */
export async function signIn(
  db: Db,
  input: { message: string; signature: Hex; domain: string; uri: string },
  now = new Date(),
): Promise<User> {
  const fields = parseSiweMessage(input.message);
  if (!fields.address || !fields.nonce) throw new SignInError("not a sign-in message");
  if (fields.chainId !== HEDERA_TESTNET_CHAIN_ID) throw new SignInError("wrong network");
  if (fields.uri !== input.uri) throw new SignInError("wrong site");
  const valid = validateSiweMessage({ message: fields, domain: input.domain, time: now });
  if (!valid) throw new SignInError("message expired or for another site");

  const ok = await verifyMessage({
    address: fields.address,
    message: input.message,
    signature: input.signature,
  }).catch(() => false);
  if (!ok) throw new SignInError("signature does not match the account");

  // Use the nonce up in the same statement that checks it, so a replay can't race us.
  const used = await db
    .update(authNonces)
    .set({ usedAt: now })
    .where(
      and(
        eq(authNonces.nonce, fields.nonce),
        isNull(authNonces.usedAt),
        gt(authNonces.expiresAt, now),
      ),
    )
    .returning({ nonce: authNonces.nonce });
  if (used.length === 0) throw new SignInError("sign-in code already used or expired");

  const address = getAddress(fields.address);
  const [user] = await db
    .insert(users)
    .values({ address })
    .onConflictDoUpdate({ target: users.address, set: { address } })
    .returning();
  if (!user) throw new SignInError("could not save the user");
  return user;
}

/** A fresh demo user: no wallet, its own chats and settings. */
export async function demoUser(db: Db): Promise<User> {
  const [user] = await db.insert(users).values({ isDemo: true, displayName: "Demo" }).returning();
  if (!user) throw new Error("could not create the demo user");
  return user;
}
