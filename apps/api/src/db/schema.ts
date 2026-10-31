import type { Card, ChatMode } from "@eth/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** A person using the app. Wallet users have an address; demo users don't. */
export const users = pgTable(
  "users",
  {
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
    // Their World ID, linked on the first human check: (issuer, private subject). One account each.
    worldIss: text("world_iss"),
    worldSub: text("world_sub"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_world_idx").on(t.worldIss, t.worldSub)],
);

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

/**
 * A chat's spending limit on Hedera (a MandateRegistry mandate). The chain enforces it; this
 * row only remembers which mandate belongs to which chat and who pays.
 */
export const mandates = pgTable(
  "mandates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    mandateId: bigint("mandate_id", { mode: "bigint" }).notNull(),
    owner: text("owner").notNull(), // EVM address that signed it (the user, or the demo wallet)
    payer: text("payer").notNull(), // the owner's Hedera account, where fees come from
    budgetUnits: bigint("budget_units", { mode: "bigint" }).notNull(),
    payees: jsonb("payees").$type<string[]>().notNull(),
    payeeNames: jsonb("payee_names").$type<Record<string, string>>().notNull().default({}),
    demo: boolean("demo").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    logSeq: integer("log_seq"), // its entry on the public spend log (HCS), if written
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mandates_chat_idx").on(t.chatId, t.createdAt)],
);

/** Every agent the concierge paid, with the proof. */
export const hires = pgTable(
  "hires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    mandateId: bigint("mandate_id", { mode: "bigint" }).notNull(),
    skill: text("skill").notNull(),
    agent: text("agent").notNull(),
    title: text("title").notNull(),
    feeUnits: bigint("fee_units", { mode: "bigint" }).notNull(),
    hederaTx: text("hedera_tx").notNull(),
    jobKey: text("job_key").notNull(),
    result: jsonb("result").$type<unknown>(),
    logSeq: integer("log_seq"), // its entry on the public spend log (HCS), if written
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hires_chat_idx").on(t.chatId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type HireRow = typeof hires.$inferSelect;
