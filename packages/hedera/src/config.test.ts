import { describe, expect, it } from "vitest";
import { hashscanTxUrl } from "./client";
import { loadConfig } from "./config";

const valid = {
  HEDERA_NETWORK: "testnet",
  HEDERA_ACCOUNT_ID: "0.0.12345",
  HEDERA_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
  HEDERA_EVM_ADDRESS: "",
};

describe("loadConfig", () => {
  it("parses a valid env", () => {
    const c = loadConfig(valid);
    expect(c.operatorId).toBe("0.0.12345");
    expect(c.operatorEvmAddress).toBeUndefined();
  });

  it("names the bad field without echoing its value", () => {
    const bad = { ...valid, HEDERA_PRIVATE_KEY: "not-a-key" };
    expect(() => loadConfig(bad)).toThrow(/HEDERA_PRIVATE_KEY/);
    expect(() => loadConfig(bad)).not.toThrow(/not-a-key/);
  });

  it("builds HashScan links", () => {
    expect(hashscanTxUrl(loadConfig(valid), "0.0.1@1.2")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.1@1.2",
    );
  });
});
