import { loadConfig } from "@eth/hedera";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { buildFacilitator } from "./build";

const facilitator = buildFacilitator({
  hedera: loadConfig(),
  spendLogTopicId: process.env.SPEND_LOG_TOPIC_ID || undefined,
});
const port = Number(process.env.PORT ?? 8402);

serve({ fetch: createApp(facilitator).fetch, port }, (info) => {
  console.log(`x402 facilitator listening on http://localhost:${info.port}`);
});
