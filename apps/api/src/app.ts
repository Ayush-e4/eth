import { health } from "@eth/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes";
import { chatRoutes } from "./chats/routes";
import type { Concierge } from "./concierge/concierge";
import type { Config } from "./config";
import type { Db } from "./db/client";
import type { HiringEnv } from "./hiring/env";
import { mandateRoutes } from "./hiring/routes";
import type { HiringService } from "./hiring/service";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AppDeps {
  concierge?: Concierge | null;
  hiring?: { env: HiringEnv; service: HiringService } | null;
}

export function createApp(db: Db, config: Config, deps: AppDeps = {}) {
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
  const { concierge = null, hiring = null } = deps;
  app.route(
    "/",
    chatRoutes(db, concierge, (id, text) => hiring?.service.noteUserMessage(id, text)),
  );
  app.route("/", mandateRoutes(db, hiring?.env ?? null));

  return app;
}
