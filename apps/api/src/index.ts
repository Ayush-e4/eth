import { NETWORKS } from "@eth/hedera";
import { DEPLOYMENTS } from "@eth/mandates";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { agentChecker } from "./builders/check";
import { closeInterruptedTurns } from "./chats/interrupted";
import { claudeConcierge } from "./concierge/concierge";
import { arkivMarket } from "./concierge/market";
import { loadConfig } from "./config";
import { oauthStore } from "./connect/oauth";
import { connectDb } from "./db/client";
import { demoQuotas, loadDemoQuotas } from "./demo/quotas";
import { bookingDesk } from "./hiring/bookings";
import { loadHiringEnv } from "./hiring/env";
import { hotelGuard } from "./hiring/hotel-guard";
import { pendingHires } from "./hiring/pending";
import { reputation } from "./hiring/reputation";
import { escrowReviews } from "./hiring/review";
import { type HiringService, hiringService } from "./hiring/service";
import { undoWindows } from "./hiring/undo";
import { type FareWatchFollower, fareWatchFollower } from "./hiring/watches";
import { marketCatalog } from "./market/catalog";
import { notifier } from "./notify/notifier";
import { chatNudge, chatPoster } from "./notify/post";
import { telegramBot } from "./notify/telegram";
import { hiddenAgentStore, visibleMarket } from "./ops/hidden";
import { arkivNames } from "./spend-log/routes";
import { statusCheck } from "./status/check";
import { openTaskService } from "./tasks/service";
import { hederaWalletChain } from "./wallet/chain";
import { passkeyWallets } from "./wallet/service";
import { humanChecks } from "./world/checks";
import { loadWorldConfig, worldClient } from "./world/oidc";

const config = loadConfig();
const { db } = await connectDb(config.databaseUrl);

// The concierge needs a Claude key; without one, chats work but messages get a clear 503.
// Hiring needs the demo wallet (operator) and the concierge's own key; without them it stays off.
const env = loadHiringEnv();
// World ID (optional): "Ask first" approvals then need a fresh human check before paying.
const world = loadWorldConfig();
// Undo windows (Hedera scheduled payments) for "Auto" chats; UNDO_SECONDS=0 turns them off.
const undoSeconds = Number(process.env.UNDO_SECONDS ?? 60);
const undo = env && undoSeconds > 0 ? undoWindows(db, env, undoSeconds) : null;
// Alerts outside the app (ntfy, Telegram): each user links their own channels.
const notify = notifier(db, {
  ntfyUrl: process.env.NTFY_URL || "https://ntfy.sh",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
});
// Passkey users' own wallets (Face ID approves their limits). WALLET_GIFT_UNITS of free test
// USDC each (0.20 by default), for at most WALLET_GIFTS_PER_DAY new wallets a day.
const wallets = env
  ? passkeyWallets(db, hederaWalletChain(env), {
      rpID: new URL(config.appOrigin).hostname,
      origin: config.appOrigin,
      giftUnits: BigInt(process.env.WALLET_GIFT_UNITS ?? 200_000),
      giftsPerDay: Number(process.env.WALLET_GIFTS_PER_DAY ?? 20),
      log: console.log,
    })
  : null;
const post = chatPoster(db, notify, config.appOrigin);
const nudge = chatNudge(db, notify, config.appOrigin);
telegramBot(notify, console.log);
// Pay on delivery: a delivered fee waits this long for the user to pay now or dispute (0 = paid
// out at once).
const reviewSeconds = Number(process.env.ESCROW_REVIEW_SECONDS ?? 120);
const review =
  env?.escrow && reviewSeconds > 0
    ? escrowReviews(
        db,
        env.escrow,
        reviewSeconds,
        (chatId, title) =>
          void nudge(
            chatId,
            `${title} delivered. It gets paid in ${Math.round(reviewSeconds / 60)} min unless you dispute: have a look.`,
          ),
      )
    : null;
// Fare watches the user hired: their alerts are posted in the chat (and booked, if asked).
const watches: FareWatchFollower | null = env
  ? fareWatchFollower(db, env, {
      hiring: (): HiringService | null => hiring?.service ?? null,
      simulate: process.env.FAREWATCH_SIMULATE === "1",
      post,
    })
  : null;
// Hires written down before paying, read back from the agent if a turn couldn't finish them.
const rate = env ? reputation(env) : undefined;
const pending = env
  ? pendingHires(db, env, {
      reputation: rate,
      review: review ?? undefined,
      watches: watches ?? undefined,
      post,
    })
  : null;
// The open market on Arkiv, shared by the concierge and the status page.
// Agents an admin hid on the ops page are left out of everything users see.
const hidden = hiddenAgentStore(db);
await hidden.refresh();
const allMarket = arkivMarket(undefined, env ? [env.demo.evm] : []);
const market = visibleMarket(allMarket, hidden);
// Is everything up? Services, networks and the shared demo wallet (public at GET /status).
const quotaConfig = loadDemoQuotas();
const status = statusCheck(db, env, { market, quotas: config.demoMode ? quotaConfig : null });
// The Market page: every agent, its reviews, whether it's up, what it did here (public).
const catalog = marketCatalog(db, { market, status });
// "List your agent": checks a builder's agent the way buyers will use it.
const checkAgent = agentChecker({
  mirrorUrl: NETWORKS.testnet.mirrorUrl,
  usdcTokenId: NETWORKS.testnet.usdcTokenId,
  executorId: DEPLOYMENTS.testnet.mandateRegistryId,
  production: config.production,
});
// Demo accounts share one test wallet: daily allowances per account and for the wallet, and a
// pause before it runs dry.
const demo = config.demoMode
  ? demoQuotas(db, quotaConfig, { usdcLeft: () => status.demoUsdc() })
  : null;
const hiring = env
  ? {
      env,
      service: hiringService(db, env, {
        requireHuman: !!world,
        reputation: rate,
        undo: undo ?? undefined,
        review: review ?? undefined,
        watches: watches ?? undefined,
        pending: pending ?? undefined,
        demo: demo ?? undefined,
        hidden: (agent) => hidden.isHidden(agent),
      }),
    }
  : null;
const checks =
  world && hiring
    ? humanChecks(db, worldClient(world), (chatId, code) => hiring.service.markHuman(chatId, code))
    : null;
// "My bookings": flights booked through agents, changed or cancelled from any chat.
const desk = env
  ? bookingDesk(db, env, {
      requireHuman: !!world,
      endpointOf: async (agent) =>
        (await market.agents("flights")).find((a) => a.agent.toLowerCase() === agent.toLowerCase())
          ?.endpoint ?? null,
    })
  : null;
// PriceGuard from the chat: watches a hotel's price, rebooks it cheaper, paid on proof.
const guard =
  env && desk
    ? hotelGuard(db, env, {
        desk,
        findAgent: async (skill) => (await market.agents(skill))[0] ?? null,
        requireHuman: !!world,
        allowSimulated: process.env.PRICEGUARD_PAY_SIMULATED === "1", // sandbox demos only
      })
    : null;
// Open tasks: the concierge posts jobs on Arkiv and agents bid by themselves.
const tasks = hiring ? openTaskService(db, hiring.env, hiring.service) : null;
// Work in progress is in the database; pick up what a restart interrupted.
void closeInterruptedTurns(db)
  .then(
    (ids) => ids.length && console.log(`${ids.length} chat(s) told their last turn was cut off`),
  )
  .catch((err) => console.error("closing interrupted turns failed:", err));
void checks?.resume().catch((err) => console.error("resuming World ID checks failed:", err));
void review?.resume().catch((err) => console.error("resuming escrow reviews failed:", err));
void pending
  ?.resume()
  .then((n) => n && console.log(`following ${n} hire(s) the last run didn't see finish`))
  .catch((err) => console.error("resuming pending hires failed:", err));
if (!world) console.warn("World ID is off: set WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET");
if (!hiring)
  console.warn(
    "hiring is off: set HEDERA_* in .env and run `pnpm --filter @eth/agents identities`",
  );
const concierge = process.env.ANTHROPIC_API_KEY
  ? claudeConcierge(market, hiring?.service ?? null, undefined, tasks, desk, guard)
  : null;
if (!concierge) console.warn("ANTHROPIC_API_KEY not set: the concierge is off");

serve(
  {
    fetch: createApp(db, config, {
      concierge,
      hiring,
      logNames: arkivNames(),
      humanChecks: checks,
      tasks,
      undo,
      review,
      watches,
      limitOffers: guard ? (chatId, card) => guard.offered(chatId, card) : undefined,
      notify,
      demo,
      status,
      catalog,
      checkAgent,
      wallets,
      connect: env ? { oauth: oauthStore(db, env.concierge.key), market, post } : null,
      ops: {
        env,
        status,
        allAgents: marketCatalog(db, { market: allMarket, status }),
        market: allMarket,
        hidden,
        giftsPerDay: Number(process.env.WALLET_GIFTS_PER_DAY ?? 20),
      },
    }).fetch,
    port: config.port,
  },
  (info) => {
    console.log(`api listening on http://localhost:${info.port} (app ${config.appOrigin})`);
  },
);
