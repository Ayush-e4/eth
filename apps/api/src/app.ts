import { health } from "@eth/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { accountRoutes } from "./account/routes";
import { authRoutes } from "./auth/routes";
import { chatRoutes } from "./chats/routes";
import type { Concierge } from "./concierge/concierge";
import type { Config } from "./config";
import type { Db } from "./db/client";
import type { HiringEnv } from "./hiring/env";
import { paymentRoutes } from "./hiring/payment-routes";
import { mandateRoutes } from "./hiring/routes";
import type { HiringService } from "./hiring/service";
import type { UndoWindows } from "./hiring/undo";
import { type LogNames, spendLogRoutes } from "./spend-log/routes";
import { openTaskRoutes } from "./tasks/routes";
import type { OpenTaskService } from "./tasks/service";
import type { HumanChecks } from "./world/checks";
import { humanCheckRoutes } from "./world/routes";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AppDeps {
  concierge?: Concierge | null;
  hiring?: { env: HiringEnv; service: HiringService } | null;
  logNames?: LogNames;
  humanChecks?: HumanChecks | null;
  tasks?: OpenTaskService | null;
  undo?: UndoWindows | null;
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
  app.route("/", accountRoutes(db, hiring?.env ?? null));
  app.route("/", spendLogRoutes(hiring?.env ?? null, deps.logNames));
  app.route("/", humanCheckRoutes(db, deps.humanChecks ?? null, hiring?.service ?? null));
  app.route("/", openTaskRoutes(db, deps.tasks ?? null));
  app.route("/", paymentRoutes(db, deps.undo ?? null));

  return app;
}
