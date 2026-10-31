import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Db } from "../db/client";
import type { DemoQuotaCheck } from "./quotas";

/** What a demo account has left today (null for wallet accounts, which aren't limited). */
export function demoRoutes(db: Db, demo: DemoQuotaCheck | null) {
  const app = new Hono<AuthEnv>();
  app.get("/demo/quota", requireUser(db), async (c) => {
    const user = c.get("user");
    return c.json({ left: user.isDemo && demo ? await demo.left(user.id) : null });
  });
  return app;
}
