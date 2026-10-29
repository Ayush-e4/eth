import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { connectDb } from "./db/client";

const config = loadConfig();
const { db } = await connectDb(config.databaseUrl);

serve({ fetch: createApp(db, config).fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port} (app ${config.appOrigin})`);
});
