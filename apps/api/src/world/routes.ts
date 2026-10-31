import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { HiringService } from "../hiring/service";
import type { HumanCheck, HumanChecks } from "./checks";

const view = (c: HumanCheck) => ({
  id: c.id,
  status: c.status,
  reason: c.reason,
  userCode: c.userCode,
  link: c.link,
  expiresAt: new Date(c.expiresAt).toISOString(),
});

/**
 * World ID checks for payment approvals. The browser starts one for an approval card it owns
 * and polls its status; the verdict is reached on the server, never taken from the browser.
 */
export function humanCheckRoutes(db: Db, checks: HumanChecks | null, hiring: HiringService | null) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/approvals/*", requireUser(db));
  app.use("/human-checks/*", requireUser(db));

  app.post("/chats/:id/approvals/:code/human-check", async (c) => {
    if (!checks || !hiring) return c.json({ error: "World ID isn't set up on this server" }, 503);
    const user = c.get("user");
    const chat = await store.get(user.id, c.req.param("id")).catch(() => null);
    const code = c.req.param("code");
    if (!chat || !hiring.pendingApproval(chat.id, code))
      return c.json({ error: "no such approval waiting" }, 404);
    const check = await checks.start(user.id, chat.id, code).catch((err: Error) => err);
    if (check instanceof Error) return c.json({ error: check.message }, 502);
    return c.json({ check: view(check) }, 201);
  });

  app.get("/human-checks/:id", (c) => {
    const check = checks?.get(c.req.param("id"), c.get("user").id);
    return check ? c.json({ check: view(check) }) : c.json({ error: "not found" }, 404);
  });

  return app;
}
