import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    createdAt: at("created_at").notNull().defaultNow(),
    lastUsedAt: at("last_used_at"),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);
