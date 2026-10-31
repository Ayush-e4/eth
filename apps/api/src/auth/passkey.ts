import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { authNonces, passkeys, type User, users } from "../db/schema";
import { SignInError } from "./siwe";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ES256 = -7; // P-256: what phones and laptops use, and what a wallet contract can check

export interface PasskeySite {
  rpID: string; // the site's hostname: a passkey only works on the site that made it
  origin: string; // https://… (or http://localhost while developing)
}

/**
 * Sign-in with a passkey: Face ID, a fingerprint, or a phone held up to a laptop. Web2 analogy:
 * "Sign in with Apple" without an Apple account. The device keeps the private key and signs a
 * one-time challenge; we keep only the public key. New passkey users pay from the demo wallet
 * (with its quotas), like the old demo button, but keep their account across visits.
 */
export function passkeyAuth(db: Db, site: PasskeySite) {
  const remember = async (challenge: string, now = new Date()) => {
    await db
      .insert(authNonces)
      .values({ nonce: challenge, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) });
  };
  // Used up in the statement that checks it, so a signed challenge can't be replayed.
  const useUp = async (challenge: string, now = new Date()) =>
    (
      await db
        .update(authNonces)
        .set({ usedAt: now })
        .where(
          and(
            eq(authNonces.nonce, challenge),
            isNull(authNonces.usedAt),
            gt(authNonces.expiresAt, now),
          ),
        )
        .returning({ nonce: authNonces.nonce })
    ).length > 0;
  const expected = { expectedOrigin: site.origin, expectedRPID: site.rpID };

  return {
    /** Options for making a new passkey (a new account). */
    async registrationOptions(name?: string) {
      const label = name?.trim() || `AgentNet ${new Date().toISOString().slice(0, 10)}`;
      const options = await generateRegistrationOptions({
        rpName: "AgentNet",
        rpID: site.rpID,
        userName: label,
        userDisplayName: label,
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        supportedAlgorithmIDs: [ES256],
      });
      await remember(options.challenge);
      return options;
    },

    /** Checks the new passkey and creates its account. */
    async register(response: RegistrationResponseJSON): Promise<User> {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: useUp,
        ...expected,
        supportedAlgorithmIDs: [ES256],
      }).catch((err: Error) => {
        throw new SignInError(`passkey not accepted: ${err.message}`);
      });
      if (!result.verified) throw new SignInError("passkey not accepted");
      const { credential } = result.registrationInfo;
      return db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ isDemo: true }).returning();
        if (!user) throw new Error("could not create the user");
        await tx.insert(passkeys).values({
          id: credential.id,
          userId: user.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? null,
        });
        return user;
      });
    },

    /** Options for signing in: any passkey this site made, picked on the device. */
    async authenticationOptions() {
      const options = await generateAuthenticationOptions({
        rpID: site.rpID,
        userVerification: "preferred",
      });
      await remember(options.challenge);
      return options;
    },

    /** Checks a sign-in signature and returns its account. */
    async authenticate(response: AuthenticationResponseJSON): Promise<User> {
      const [row] = await db
        .select({ key: passkeys, user: users })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.id, response.id))
        .limit(1);
      if (!row) throw new SignInError("this passkey isn't registered here (it may be deleted)");
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: useUp,
        ...expected,
        credential: {
          id: row.key.id,
          publicKey: isoBase64URL.toBuffer(row.key.publicKey),
          counter: row.key.counter,
          transports: (row.key.transports ?? undefined) as never,
        },
      }).catch((err: Error) => {
        throw new SignInError(`passkey not accepted: ${err.message}`);
      });
      if (!result.verified) throw new SignInError("passkey not accepted");
      await db
        .update(passkeys)
        .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(passkeys.id, row.key.id));
      return row.user;
    },
  };
}
