import { Hono } from "hono";
import type { StatusCheck } from "./check";

/** Public: is AgentNet up? (No account needed; nothing private in it.) */
export function statusRoutes(status: StatusCheck | null) {
  const app = new Hono();
  app.get("/status", async (c) =>
    status ? c.json(await status.get()) : c.json({ error: "status is off" }, 503),
  );
  return app;
}
