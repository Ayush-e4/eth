import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { claudeConcierge } from "./concierge/concierge";
import { arkivMarket } from "./concierge/market";
import { loadConfig } from "./config";
import { connectDb } from "./db/client";
import { loadHiringEnv } from "./hiring/env";
import { hiringService } from "./hiring/service";

const config = loadConfig();
const { db } = await connectDb(config.databaseUrl);

// The concierge needs a Claude key; without one, chats work but messages get a clear 503.
// Hiring needs the demo wallet (operator) and the concierge's own key; without them it stays off.
const env = loadHiringEnv();
const hiring = env ? { env, service: hiringService(db, env) } : null;
if (!hiring)
  console.warn(
    "hiring is off: set HEDERA_* in .env and run `pnpm --filter @eth/agents identities`",
  );
const concierge = process.env.ANTHROPIC_API_KEY
  ? claudeConcierge(arkivMarket(), hiring?.service ?? null)
  : null;
if (!concierge) console.warn("ANTHROPIC_API_KEY not set: the concierge is off");

serve({ fetch: createApp(db, config, { concierge, hiring }).fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port} (app ${config.appOrigin})`);
});
