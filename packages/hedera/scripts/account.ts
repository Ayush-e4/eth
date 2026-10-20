// Shows the operator account and its balances (read-only, no fees).
// Run: pnpm --filter @eth/hedera account
import {
  hashscanAccountUrl,
  loadConfig,
  Mirror,
  NETWORKS,
  tinybarsToHbar,
  unitsToUsdc,
} from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const b = await new Mirror(net.mirrorUrl).balances(config.operatorId);
const usdc = b.tokens[net.usdcTokenId];

console.log(`network     ${config.network}`);
console.log(`account     ${b.accountId}`);
console.log(`evm address ${b.evmAddress ?? "(none)"}`);
console.log(`HBAR        ${tinybarsToHbar(b.tinybars)}`);
console.log(
  `USDC        ${usdc === undefined ? "not associated yet" : unitsToUsdc(usdc)} (${net.usdcTokenId})`,
);
console.log(`hashscan    ${hashscanAccountUrl(config, b.accountId)}`);
