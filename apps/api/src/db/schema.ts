import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A person using the app. Wallet users have an address; demo users don't. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Checksummed EVM address (MetaMask on Hedera testnet). Null for demo users.
  address: text("address").unique(),
  displayName: text("display_name"),
  homeCity: text("home_city"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time codes handed out for Sign-In with Ethereum. Each can be used once. */
export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/** Signed-in sessions. We store only a hash of the cookie token, never the token. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type User = typeof users.$inferSelect;
