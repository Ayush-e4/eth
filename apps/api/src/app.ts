import { health } from "@eth/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes";
import { chatRoutes } from "./chats/routes";
import type { Concierge } from "./concierge/concierge";
import type { Config } from "./config";
import type { Db } from "./db/client";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(db: Db, config: Config, concierge: Concierge | null = null) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.appOrigin,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Session cookies ride along on every request, so refuse writes from other sites.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && origin && origin !== config.appOrigin) {
      return c.json({ error: "cross-site request refused" }, 403);
    }
    await next();
  });

  app.get("/health", (c) => c.json(health("api")));
  app.route("/", authRoutes(db, config));
  app.route("/", chatRoutes(db, concierge));

  return app;
}
