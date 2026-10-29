import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { claudeConcierge } from "./concierge/concierge";
import { arkivMarket } from "./concierge/market";
import { loadConfig } from "./config";
import { connectDb } from "./db/client";

const config = loadConfig();
const { db } = await connectDb(config.databaseUrl);

// The concierge needs a Claude key; without one, chats work but messages get a clear 503.
const concierge = process.env.ANTHROPIC_API_KEY ? claudeConcierge(arkivMarket()) : null;
if (!concierge) console.warn("ANTHROPIC_API_KEY not set: the concierge is off");

serve({ fetch: createApp(db, config, concierge).fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port} (app ${config.appOrigin})`);
});
