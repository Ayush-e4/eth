import type { Card, ChatMode } from "@eth/shared";
import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A person using the app. Wallet users have an address; demo users don't. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Checksummed EVM address (MetaMask on Hedera testnet). Null for demo users.
  address: text("address").unique(),
  displayName: text("display_name"),
  homeCity: text("home_city"),
  isDemo: boolean("is_demo").notNull().default(false),
  // Defaults for new chats, chosen during setup.
  defaultMode: text("default_mode").$type<ChatMode>().notNull().default("auto"),
  defaultLimitUnits: bigint("default_limit_units", { mode: "bigint" })
    .notNull()
    .default(sql`300000`),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
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

/** A conversation. Spending settings live here so each chat can have its own limit. */
export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    mode: text("mode").$type<ChatMode>().notNull().default("auto"),
    // Most agent fees this chat may spend without asking, in USDC base units (0.30 USDC).
    limitUnits: bigint("limit_units", { mode: "bigint" }).notNull().default(sql`300000`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chats_user_updated_idx").on(t.userId, t.updatedAt)],
);

/** One turn in a chat: the text, plus any cards the concierge showed with it. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    text: text("text").notNull(),
    cards: jsonb("cards").$type<Card[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_chat_idx").on(t.chatId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
