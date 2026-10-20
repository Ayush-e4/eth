// Creates an HCS topic, writes one message, and reads it back from the mirror node.
// Run: pnpm --filter @eth/hedera hcs-demo [existing-topic-id]
import {
  createClient,
  createTopic,
  hashscanTxUrl,
  loadConfig,
  Mirror,
  NETWORKS,
  submitMessage,
} from "../src";

const config = loadConfig();
const client = createClient(config);
const mirror = new Mirror(NETWORKS[config.network].mirrorUrl);

let topicId = process.argv[2];
if (!topicId) {
  const t = await createTopic(client, { memo: "eth dev log", submitKey: config.operatorKey });
  topicId = t.topicId;
  console.log(`created topic ${topicId}  ${hashscanTxUrl(config, t.transactionId)}`);
}

const entry = { kind: "hello", from: config.operatorId, at: new Date().toISOString() };
const sent = await submitMessage(client, {
  topicId,
  message: entry,
  submitKey: config.operatorKey,
});
client.close();
console.log(`wrote message #${sent.sequence}  ${hashscanTxUrl(config, sent.transactionId)}`);

// The mirror node lags consensus by a few seconds.
for (let attempt = 0; attempt < 10; attempt++) {
  const [latest] = await mirror.topicMessages(topicId, 1);
  if (latest && latest.sequence >= sent.sequence) {
    console.log(`read back #${latest.sequence}: ${latest.text}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("mirror node has not caught up yet — try again in a few seconds");
