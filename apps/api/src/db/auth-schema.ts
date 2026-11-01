import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

const at = (name: string) => timestamp(name, { withTimezone: true });

/**
 * One-time codes: the nonce in a Sign-In with Ethereum message, or the challenge a passkey
 * signs. Each can be used once.
 */
export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: at("expires_at").notNull(),
  usedAt: at("used_at"),
});

/** Signed-in sessions. We store only a hash of the cookie token, never the token. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Passkeys (Face ID, fingerprint, a phone): the private key never leaves the person's device;
 * we keep its public key and check each sign-in's signature against it. P-256 only, so the same
 * key can later control an on-chain wallet.
 */
export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(), // the credential id (base64url), as the browser reports it
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(), // COSE-encoded, base64url
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[]>(),
    label: text("label"), // the device it was made on, e.g. "iPhone · Safari"
    onWallet: boolean("on_wallet").notNull().default(false), // may approve the wallet's moves
    createdAt: at("created_at").notNull().defaultNow(),
    lastUsedAt: at("last_used_at"),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/**
 * A passkey user's own wallet on Hedera (a PasskeyWallet contract), so Face ID approves their
 * spending limits. We make it at sign-up and pay its gas. v1 answers to the passkey that made
 * it; v2 to each of the user's passkeys with `onWallet` (one per device, added from a trusted one).
 */
export const passkeyWallets = pgTable("passkey_wallets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passkeyId: text("passkey_id").notNull(), // the passkey that made it
  version: integer("version").notNull().default(1), // PasskeyWallet (1) or PasskeyWalletV2 (2)
  address: text("address").notNull(), // EVM address (known before it exists: CREATE2)
  hederaId: text("hedera_id"), // 0.0.x, once the mirror has seen it
  status: text("status").notNull().default("creating"), // creating | ready | failed
  giftUnits: bigint("gift_units", { mode: "bigint" }), // free test USDC we sent it, if any
  createdAt: at("created_at").notNull().defaultNow(),
});
