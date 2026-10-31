import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema";

/**
 * Agents an admin hid from AgentNet (the ops page): left out of the Market page, the concierge's
 * search and quotes, until unhidden. Their Arkiv listing is theirs and stays; we just don't use it.
 */
export const hiddenAgents = pgTable("hidden_agents", {
  agent: text("agent").primaryKey(), // EVM address, lowercase
  name: text("name").notNull(),
  reason: text("reason").notNull(),
  hiddenBy: uuid("hidden_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
