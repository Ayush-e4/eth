import type { Card, ChatMode } from "@eth/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
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

// ── Work in progress that must survive a restart (it used to live in memory) ──

const chatRef = () =>
  uuid("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" });
const at = (name: string) => timestamp(name, { withTimezone: true });

/** Quotes held under short refs: ref = "q" + n. Round and option are JSON (bigints encoded). */
export const quoteRefs = pgTable(
  "quote_refs",
  {
    n: serial("n").primaryKey(),
    chatId: chatRef(),
    task: text("task").notNull(), // the round's task id (dropped together after a hire)
    optionKey: text("option_key").notNull(),
    round: jsonb("round").$type<unknown>().notNull(),
    option: jsonb("option").$type<unknown>().notNull(),
    heldAt: at("held_at").notNull().defaultNow(),
  },
  (t) => [index("quote_refs_chat_idx").on(t.chatId, t.heldAt)],
);

/** "Ask first" approvals: one code per payment the concierge asked for. */
export const approvals = pgTable(
  "approvals",
  {
    chatId: chatRef(),
    code: text("code").notNull(),
    ref: text("ref").notNull(),
    agent: text("agent").notNull(),
    feeUnits: bigint("fee_units", { mode: "bigint" }).notNull(),
    approved: boolean("approved").notNull().default(false),
    humanAt: at("human_at"), // when a World ID check for this approval passed
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.code] })],
);

/** World ID checks in progress. The device code never leaves the server. */
export const humanChecks = pgTable("human_checks", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  chatId: chatRef(),
  code: text("code").notNull(),
  userCode: text("user_code").notNull(),
  link: text("link").notNull(),
  deviceCode: text("device_code").notNull(),
  intervalS: integer("interval_s").notNull(),
  startedAtS: integer("started_at_s").notNull(),
  expiresAt: at("expires_at").notNull(),
  status: text("status").notNull().default("waiting"),
  reason: text("reason"),
});

/** Jobs the concierge posted on Arkiv for agents to bid on. */
export const openTasks = pgTable("open_tasks", {
  task: text("task").primaryKey(),
  chatId: chatRef(),
  entityKey: text("entity_key").notNull(),
  skill: text("skill").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  closesAt: at("closes_at").notNull(),
  awarded: boolean("awarded").notNull().default(false),
});

/** Payments in their undo window (Hedera schedules), and how they ended. */
export const scheduledPayments = pgTable("scheduled_payments", {
  scheduleId: text("schedule_id").primaryKey(),
  chatId: chatRef(),
  paymentKey: text("payment_key").notNull(),
  executesAt: at("executes_at").notNull(),
  status: text("status").notNull().default("scheduled"),
  createdAt: at("created_at").notNull().defaultNow(),
});

/**
 * Hires being paid or worked on. Written before paying; removed once the agent delivered or
 * failed. Whatever is left after a restart (or a reply that came too late) is read back from the
 * agent (GET /jobs) and posted to its chat. Round, option and delegation are JSON (bigints encoded).
 */
export const pendingHires = pgTable("pending_hires", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: chatRef(),
  mandateId: bigint("mandate_id", { mode: "bigint" }).notNull(),
  payer: text("payer").notNull(),
  endpoint: text("endpoint").notNull(),
  quoteKey: text("quote_key").notNull(),
  round: jsonb("round").$type<unknown>().notNull(),
  option: jsonb("option").$type<unknown>().notNull(),
  delegation: jsonb("delegation").$type<unknown>(),
  label: text("label").notNull(),
  reason: text("reason").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type HireRow = typeof hires.$inferSelect;
