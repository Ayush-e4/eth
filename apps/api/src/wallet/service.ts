import { randomUUID } from "node:crypto";
import { assertionFromWebAuthn, type PasskeyKey, type WalletCall } from "@eth/mandates";
import type { Card } from "@eth/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, count, eq, gte, isNotNull } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { Db } from "../db/client";
import { passkeys, passkeyWallets as wallets } from "../db/schema";
import type { WalletChain } from "./chain";

const OP_TTL_MS = 5 * 60 * 1000;

export interface WalletOptions {
  rpID: string;
  origin: string;
  giftUnits: bigint; // free test USDC for a new wallet (0 = none)
  giftsPerDay: number; // across everyone, so making accounts can't drain the demo wallet
  log?: (line: string) => void;
}

export class WalletOpError extends Error {}

/** What a prepared move is for, so the second step can be checked against the first. */
export type WalletOpMeta =
  | { kind: "limit"; chatId: string; card: Extract<Card, { type: "limit" }> }
  | { kind: "revoke"; limitId: string }
  | { kind: "connect"; connectionId: string }
  | { kind: "device"; passkeyId: string; add: boolean };

type Op = {
  userId: string;
  keys: string[]; // the passkeys that may sign it
  version: number;
  wallet: Address;
  calls: WalletCall[];
  deadline: bigint;
  digest: Hex;
  meta: WalletOpMeta;
  expires: number;
};

/** A passkey's public key (stored COSE) as the wallet contract wants it: x and y. */
export function passkeyKey(coseB64url: string): PasskeyKey {
  const cose = decodeCredentialPublicKey(isoBase64URL.toBuffer(coseB64url)) as Map<number, unknown>;
  const hex = (b: unknown) => `0x${Buffer.from(b as Uint8Array).toString("hex")}` as Hex;
  if (cose.get(3) !== -7) throw new Error("not a P-256 passkey");
  return { qx: hex(cose.get(-2)), qy: hex(cose.get(-3)) };
}

/**
 * Passkey users' own wallets. Made at sign-up (we pay the gas and send some free test USDC);
 * afterwards every move is a batch of calls the person approves with Face ID: we prepare it,
 * their device signs its digest as a WebAuthn challenge, we submit it. The contract checks the
 * signature, so a batch we changed (or anyone else's) simply fails.
 */
export function passkeyWallets(db: Db, chain: WalletChain, opts: WalletOptions) {
  const ops = new Map<string, Op>();
  const making = new Map<string, Promise<void>>();

  const row = async (userId: string) =>
    (await db.select().from(wallets).where(eq(wallets.userId, userId)))[0] ?? null;

  /** The passkeys a wallet answers to: v1 the one that made it, v2 each one added to it. */
  const keysOf = (w: typeof wallets.$inferSelect) =>
    db
      .select()
      .from(passkeys)
      .where(
        w.version >= 2
          ? and(eq(passkeys.userId, w.userId), eq(passkeys.onWallet, true))
          : eq(passkeys.id, w.passkeyId),
      );

  async function giftAllowed() {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [r] = await db
      .select({ n: count() })
      .from(wallets)
      .where(and(isNotNull(wallets.giftUnits), gte(wallets.createdAt, since)));
    return opts.giftUnits > 0n && (r?.n ?? 0) < opts.giftsPerDay;
  }

  async function make(userId: string) {
    const [key] = await db.select().from(passkeys).where(eq(passkeys.userId, userId)).limit(1);
    if (!key) return;
    const k = passkeyKey(key.publicKey);
    const address = await chain.addressOf(k);
    const made = { passkeyId: key.id, address, version: chain.version };
    await db
      .insert(wallets)
      .values({ userId, ...made })
      .onConflictDoUpdate({ target: wallets.userId, set: { ...made, status: "creating" } });
    await db.update(passkeys).set({ onWallet: true }).where(eq(passkeys.id, key.id));
    try {
      await chain.create(k);
      let hederaId: string | null = null;
      for (let i = 0; i < 15 && !hederaId; i++) {
        hederaId = await chain.hederaIdOf(address).catch(() => null);
        if (!hederaId) await new Promise((r) => setTimeout(r, 2000));
      }
      const before = await row(userId);
      const gift = before?.giftUnits == null && (await giftAllowed()) ? opts.giftUnits : null;
      if (gift) await chain.gift(address, gift);
      await db
        .update(wallets)
        .set({ status: "ready", hederaId, ...(gift ? { giftUnits: gift } : {}) })
        .where(eq(wallets.userId, userId));
    } catch (err) {
      opts.log?.(`passkey wallet for ${userId} failed: ${String(err).slice(0, 160)}`);
      await db.update(wallets).set({ status: "failed" }).where(eq(wallets.userId, userId));
    }
  }

  return {
    /** The user's wallet, with its USDC (null if they have none: not a passkey user). */
    async get(userId: string, withBalance = true) {
      const w = await row(userId);
      if (!w) return null;
      const balance =
        withBalance && w.status === "ready"
          ? await chain.balanceOf(w.address as Address).catch(() => null)
          : null;
      return {
        address: w.address,
        hederaId: w.hederaId,
        status: w.status,
        version: w.version,
        usdcUnits: balance?.toString() ?? null,
        giftUnits: w.giftUnits?.toString() ?? null,
      };
    },

    /** Makes the wallet if it isn't made (or retries a failed one). Resolves when done. */
    ensure(userId: string): Promise<void> {
      const running = making.get(userId);
      if (running) return running;
      const p = row(userId)
        .then((w) => (w && w.status !== "failed" ? undefined : make(userId)))
        .finally(() => making.delete(userId));
      making.set(userId, p);
      return p;
    },

    /** Step 1 of a move: what the device signs (WebAuthn request options), and an op id. */
    async prepare(userId: string, calls: WalletCall[], meta: WalletOpMeta) {
      const w = await row(userId);
      if (w?.status !== "ready") throw new WalletOpError("your wallet isn't ready yet");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + OP_TTL_MS / 1000);
      const digest = await chain.digest(w.address as Address, calls, deadline);
      const opId = randomUUID();
      const keys = await keysOf(w);
      const op = { userId, keys: keys.map((k) => k.id), version: w.version };
      ops.set(opId, {
        ...op,
        wallet: w.address as Address,
        calls,
        deadline,
        digest,
        meta,
        expires: Date.now() + OP_TTL_MS,
      });
      return {
        opId,
        options: {
          challenge: isoBase64URL.fromBuffer(Buffer.from(digest.slice(2), "hex")),
          rpId: opts.rpID,
          allowCredentials: keys.map((k) => ({
            id: k.id,
            type: "public-key" as const,
            transports: k.transports ?? [],
          })),
          userVerification: "required" as const,
          timeout: 120_000,
        },
      };
    },

    /** What a prepared op is for (to check it against the request), without using it up. */
    meta(userId: string, opId: string): WalletOpMeta | null {
      const op = ops.get(opId);
      return op && op.userId === userId && op.expires > Date.now() ? op.meta : null;
    },

    /** Step 2: the device's signature came back; run the batch on Hedera. */
    async run(userId: string, opId: string, response: AuthenticationResponseJSON, gas?: bigint) {
      const op = ops.get(opId);
      if (!op || op.userId !== userId || op.expires < Date.now())
        throw new WalletOpError("that approval expired; try again");
      ops.delete(opId); // one go, even if it fails
      if (!op.keys.includes(response.id))
        throw new WalletOpError("that passkey can't approve this wallet's payments");
      const client = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)) as {
        origin?: string;
        challenge?: string;
      };
      const challenge = isoBase64URL.fromBuffer(Buffer.from(op.digest.slice(2), "hex"));
      if (client.origin !== opts.origin || client.challenge !== challenge)
        throw new WalletOpError("that signature is for something else");
      const assertion = assertionFromWebAuthn(response.response);
      const [key] = await db.select().from(passkeys).where(eq(passkeys.id, response.id));
      const sig =
        op.version >= 2 && key ? { ...passkeyKey(key.publicKey), sig: assertion } : assertion;
      const result = await chain.execute(op.wallet, op.calls, op.deadline, sig, gas);
      return { ...result, wallet: op.wallet, meta: op.meta };
    },
  };
}

export type PasskeyWallets = ReturnType<typeof passkeyWallets>;
