import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Db } from "../db/client";
import type { AgentChecker } from "./check";

const Body = z.object({
  endpoint: z.string().min(8).max(300),
  sample: z.unknown().optional(), // a sample input, to try a real quote and the paywall
});
const PER_HOUR = 10;

/** "List your agent": check an agent's address against what the market needs. Signed-in only. */
export function builderRoutes(db: Db, check: AgentChecker | null) {
  const app = new Hono<AuthEnv>();
  const recent = new Map<string, number[]>(); // user → times of their checks this hour
  app.post("/builders/check", requireUser(db), async (c) => {
    if (!check) return c.json({ error: "the checker is off" }, 503);
    const user = c.get("user").id;
    const now = Date.now();
    const mine = (recent.get(user) ?? []).filter((t) => now - t < 3_600_000);
    if (mine.length >= PER_HOUR)
      return c.json({ error: `${PER_HOUR} checks an hour at most; try again a bit later` }, 429);
    recent.set(user, [...mine, now]);
    const body = Body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send { endpoint, sample? }" }, 400);
    return c.json(await check(body.data.endpoint, body.data.sample));
  });
  return app;
}
