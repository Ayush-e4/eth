import type { HiringEnv } from "../hiring/env";

// A hiring setup for tests: the concierge, the demo wallet and one agent's quote.

export const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
export const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8" },
  demo: {
    key: `0x${"22".repeat(32)}`,
    evm: "0x0000000000000000000000000000000000000d3d",
    account: "0.0.1001",
  },
  mc: { publicClient: {}, chain: { id: 296 } },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  usdc: "0x0000000000000000000000000000000000068cda",
  usdcTokenId: "0.0.429274",
  mirrorUrl: "https://mirror",
} as unknown as HiringEnv;

export const option = {
  key: "0xquote",
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹14,282",
  feeUnits: 30_000n,
  endpoint: "http://a",
};
export const round = {
  skill: "flights",
  task: "t",
  input: {},
  options: [option],
  bestReason: "lowest total",
  skipped: [],
};
