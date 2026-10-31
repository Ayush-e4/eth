import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { FareWatchFollower } from "./watches";

/** A chat's fare watches, owner only: how one stands (checks, alerts), stop, check now. */
export function watchRoutes(db: Db, watches: FareWatchFollower | null) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/watches/*", requireUser(db));
  const chatOf = (c: { get(k: "user"): { id: string } }, id: string) =>
    store.get(c.get("user").id, id).catch(() => null);

  app.get("/chats/:id/watches/:watchId", async (c) => {
    if (!watches) return c.json({ error: "fare watches are off on this server" }, 503);
    const chat = await chatOf(c, c.req.param("id"));
    const w = chat ? await watches.status(chat.id, c.req.param("watchId")).catch(() => null) : null;
    return w ? c.json({ watch: w }) : c.json({ error: "no such watch in this chat" }, 404);
  });

  for (const action of ["stop", "check-now", "simulate"] as const)
    app.post(`/chats/:id/watches/:watchId/${action}`, async (c) => {
      if (!watches) return c.json({ error: "fare watches are off on this server" }, 503);
      if (action === "simulate" && !watches.simulate)
        return c.json({ error: "simulated drops are off on this server" }, 404);
      const chat = await chatOf(c, c.req.param("id"));
      if (!chat) return c.json({ error: "chat not found" }, 404);
      const w = await watches.act(chat.id, c.req.param("watchId"), action).catch((err: Error) => {
        throw new WatchError(err.message);
      });
      return w ? c.json({ watch: w }) : c.json({ error: "no such watch in this chat" }, 404);
    });

  app.onError((err, c) =>
    err instanceof WatchError
      ? c.json({ error: err.message }, 409)
      : c.json({ error: "failed" }, 500),
  );
  return app;
}

class WatchError extends Error {}
