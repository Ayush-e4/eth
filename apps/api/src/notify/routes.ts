import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import type { Db } from "../db/client";
import type { Notifier } from "./notifier";

/** The signed-in user's alert channels: see them, link ntfy or Telegram, test, unlink. */
export function notifyRoutes(db: Db, n: Notifier | null) {
  const app = new Hono<AuthEnv>();
  app.use("/notifications", requireUser(db));
  app.use("/notifications/*", requireUser(db));
  const off = (c: { json: (b: unknown, s: 503) => Response }) =>
    c.json({ error: "alerts are off on this server" }, 503);

  app.get("/notifications", async (c) => (n ? c.json(await n.channels(c.get("user").id)) : off(c)));
  app.post("/notifications/ntfy", async (c) =>
    n ? c.json({ ntfy: await n.linkNtfy(c.get("user").id) }) : off(c),
  );
  app.post("/notifications/telegram", async (c) => {
    if (!n) return off(c);
    const url = await n.startTelegram(c.get("user").id);
    return url
      ? c.json({ url })
      : c.json({ error: "Telegram isn't set up on this server (no bot token)" }, 503);
  });
  app.post("/notifications/test", async (c) => {
    if (!n) return off(c);
    const sent = await n.send(c.get("user").id, {
      title: "AgentNet",
      text: "Alerts work: fare drops, agents' news and payments to review will show up here.",
    });
    return c.json({ sent });
  });
  app.delete("/notifications/:channel", async (c) => {
    if (!n) return off(c);
    const channel = c.req.param("channel");
    if (channel !== "ntfy" && channel !== "telegram")
      return c.json({ error: "no such channel" }, 404);
    await n.unlink(c.get("user").id, channel);
    return c.json({ ok: true });
  });
  return app;
}
