import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats, users } from "./schema";

const at = (name: string) => timestamp(name, { withTimezone: true });

/** Apps that registered to connect (OAuth dynamic client registration), e.g. Claude. */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(), // the client_id we handed out
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
});

/**
 * A user's app connection: the app may hire agents from the user's own wallet, within a limit
 * the user approved with Face ID for this connection's key (derived from a server secret, never
 * stored). Its hires land in its own chat, so the user sees everything the app does.
 */
export const appConnections = pgTable(
  "app_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    clientName: text("client_name").notNull(),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    agentAddress: text("agent_address").notNull(), // the mandate's agent: signs this app's payments
    mandateId: bigint("mandate_id", { mode: "bigint" }),
    payer: text("payer"), // the user's wallet, as a Hedera account
    budgetUnits: bigint("budget_units", { mode: "bigint" }).notNull(),
    perPaymentCapUnits: bigint("per_payment_cap_units", { mode: "bigint" }).notNull(),
    expiresAt: at("expires_at").notNull(),
    status: text("status").notNull().default("pending"), // pending | active | revoked
    createdAt: at("created_at").notNull().defaultNow(),
    lastUsedAt: at("last_used_at"),
  },
  (t) => [index("app_connections_user_idx").on(t.userId)],
);

/** OAuth codes and tokens. Only a SHA-256 hash of each is stored. */
export const oauthTokens = pgTable("oauth_tokens", {
  hash: text("hash").primaryKey(),
  kind: text("kind").notNull(), // code | access | refresh
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => appConnections.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  codeChallenge: text("code_challenge"), // PKCE (S256), codes only
  redirectUri: text("redirect_uri"), // codes only
  expiresAt: at("expires_at").notNull(),
  usedAt: at("used_at"),
});
