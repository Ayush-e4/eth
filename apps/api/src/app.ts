import { type Card, health } from "@eth/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { accountRoutes } from "./account/routes";
import { authRoutes } from "./auth/routes";
import type { AgentChecker } from "./builders/check";
import { builderRoutes } from "./builders/routes";
import { chatRoutes, type FindAgent } from "./chats/routes";
import type { Concierge } from "./concierge/concierge";
import type { Market } from "./concierge/market";
import type { Config } from "./config";
import { mcpRoutes } from "./connect/mcp";
import type { OAuthStore } from "./connect/oauth";
import { connectRoutes } from "./connect/routes";
import type { Db } from "./db/client";
import type { DemoQuotaCheck } from "./demo/quotas";
import { demoRoutes } from "./demo/routes";
import type { HiringEnv } from "./hiring/env";
import { paymentRoutes } from "./hiring/payment-routes";
import type { EscrowReviews } from "./hiring/review";
import { mandateRoutes } from "./hiring/routes";
import type { HiringService } from "./hiring/service";
import type { UndoWindows } from "./hiring/undo";
import { watchRoutes } from "./hiring/watch-routes";
import type { FareWatchFollower } from "./hiring/watches";
import type { MarketCatalog } from "./market/catalog";
import { marketRoutes } from "./market/routes";
import type { Notifier } from "./notify/notifier";
import type { ChatPoster } from "./notify/post";
import { notifyRoutes } from "./notify/routes";
import { type OpsDeps, opsRoutes } from "./ops/routes";
import { type LogNames, spendLogRoutes } from "./spend-log/routes";
import type { StatusCheck } from "./status/check";
import { statusRoutes } from "./status/routes";
import { openTaskRoutes } from "./tasks/routes";
import type { OpenTaskService } from "./tasks/service";
import type { PasskeyWallets } from "./wallet/service";
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
  review?: EscrowReviews | null;
  notify?: Notifier | null;
  /** One-off limits the server offered for a single payment (PriceGuard's fee). */
  limitOffers?: (chatId: string, card: Extract<Card, { type: "limit" }>) => boolean;
  watches?: FareWatchFollower | null;
  demo?: DemoQuotaCheck | null;
  status?: StatusCheck | null;
  catalog?: MarketCatalog | null;
  checkAgent?: AgentChecker | null;
  wallets?: PasskeyWallets | null;
  ops?: OpsDeps | null;
  /** Connected apps (MCP over OAuth): who they are, and what they may browse. */
  connect?: { oauth: OAuthStore; market: Market; post: ChatPoster | null } | null;
}

/** A listed agent's name and skill, for starting a chat with it alone. */
const finder =
  (catalog: MarketCatalog | null | undefined): FindAgent =>
  async (address) => {
    const a = (await catalog?.list())?.agents.find(
      (x) => x.agent.toLowerCase() === address.toLowerCase(),
    );
    return a ? { name: a.name, skill: a.skill } : null;
  };

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
    // Connected apps call these from their own servers with bearer tokens, not our cookie.
    const bearer = c.req.path === "/mcp" || c.req.path.startsWith("/oauth/token");
    if (!SAFE_METHODS.has(c.req.method) && origin && origin !== config.appOrigin && !bearer) {
      return c.json({ error: "cross-site request refused" }, 403);
    }
    await next();
  });

  app.get("/health", (c) => c.json(health("api")));
  app.route("/", authRoutes(db, config, deps.wallets ?? null));
  const { concierge = null, hiring = null } = deps;
  app.route(
    "/",
    chatRoutes(
      db,
      concierge,
      (id, text) => hiring?.service.noteUserMessage(id, text),
      deps.demo ?? null,
      finder(deps.catalog),
    ),
  );
  app.route(
    "/",
    mandateRoutes(
      db,
      hiring?.env ?? null,
      deps.demo ?? null,
      deps.limitOffers ?? undefined,
      deps.wallets ?? null,
    ),
  );
  app.route("/", demoRoutes(db, deps.demo ?? null));
  app.route("/", statusRoutes(deps.status ?? null));
  app.route("/", marketRoutes(deps.catalog ?? null));
  app.route("/", builderRoutes(db, deps.checkAgent ?? null));
  app.route("/", accountRoutes(db, hiring?.env ?? null, deps.wallets ?? null));
  app.route("/", spendLogRoutes(hiring?.env ?? null, deps.logNames));
  app.route("/", humanCheckRoutes(db, deps.humanChecks ?? null, hiring?.service ?? null));
  app.route("/", openTaskRoutes(db, deps.tasks ?? null));
  app.route("/", paymentRoutes(db, deps.undo ?? null, deps.review ?? null));
  app.route("/", watchRoutes(db, deps.watches ?? null));
  app.route("/", notifyRoutes(db, deps.notify ?? null));
  if (deps.ops) app.route("/", opsRoutes(db, config, deps.ops));
  if (deps.connect) {
    const env = hiring?.env ?? null;
    const { oauth, market, post } = deps.connect;
    app.route("/", connectRoutes(db, config, { oauth, env, wallets: deps.wallets ?? null }));
    const hidden = deps.ops?.hidden;
    app.route(
      "/",
      mcpRoutes(db, config.appOrigin, {
        oauth,
        env,
        market,
        post,
        hidden: hidden ? (a) => hidden.isHidden(a) : undefined,
      }),
    );
  }

  return app;
}
