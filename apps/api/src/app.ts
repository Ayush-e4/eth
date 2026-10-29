import { health } from "@eth/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes";
import type { Config } from "./config";
import type { Db } from "./db/client";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(db: Db, config: Config) {
  const app = new Hono();

  app.use("*", cors({ origin: config.appOrigin, credentials: true }));

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

  return app;
}
