import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { claudeConcierge } from "./concierge/concierge";
import { arkivMarket } from "./concierge/market";
import { loadConfig } from "./config";
import { connectDb } from "./db/client";
import { loadHiringEnv } from "./hiring/env";
import { reputation } from "./hiring/reputation";
import { hiringService } from "./hiring/service";
import { undoWindows } from "./hiring/undo";
import { arkivNames } from "./spend-log/routes";
import { openTaskService } from "./tasks/service";
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
const undo = env && undoSeconds > 0 ? undoWindows(env, undoSeconds) : null;
const hiring = env
  ? {
      env,
      service: hiringService(db, env, {
        requireHuman: !!world,
        reputation: reputation(env),
        undo: undo ?? undefined,
      }),
    }
  : null;
const checks =
  world && hiring
    ? humanChecks(db, worldClient(world), (chatId, code) => hiring.service.markHuman(chatId, code))
    : null;
// Open tasks: the concierge posts jobs on Arkiv and agents bid by themselves.
const tasks = hiring ? openTaskService(hiring.env, hiring.service) : null;
if (!world) console.warn("World ID is off: set WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET");
if (!hiring)
  console.warn(
    "hiring is off: set HEDERA_* in .env and run `pnpm --filter @eth/agents identities`",
  );
const concierge = process.env.ANTHROPIC_API_KEY
  ? claudeConcierge(
      arkivMarket(undefined, hiring ? [hiring.env.demo.evm] : []),
      hiring?.service ?? null,
      undefined,
      tasks,
    )
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
    }).fetch,
    port: config.port,
  },
  (info) => {
    console.log(`api listening on http://localhost:${info.port} (app ${config.appOrigin})`);
  },
);
