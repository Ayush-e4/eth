// Creates an HCS topic writable only by the operator. Prints its id.
// Run: pnpm --filter @eth/hedera create-topic "<memo>"
import { createClient, createTopic, hashscanTxUrl, loadConfig } from "../src";

const config = loadConfig();
const client = createClient(config);
const memo = process.argv[2] ?? "eth topic";
const { topicId, transactionId } = await createTopic(client, {
  memo,
  submitKey: config.operatorKey,
});
client.close();
console.log(topicId);
console.error(`created "${memo}"  ${hashscanTxUrl(config, transactionId)}`);
