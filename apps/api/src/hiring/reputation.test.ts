import { describe, expect, it, vi } from "vitest";
import type { HiringEnv } from "./env";
import { reputation } from "./reputation";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  findAgents: vi.fn(async () => [
    { record: { agent: "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13", erc8004Id: 131n } },
    { record: { agent: "0x1111111111111111111111111111111111111111" } }, // no identity yet
  ]),
}));

const env = { demo: { key: `0x${"22".repeat(32)}` } } as unknown as HiringEnv;

describe("reviews on ERC-8004 after a paid job", () => {
  it("rates the agent's identity 100 from the paying wallet", async () => {
    const giveFeedback = vi.fn(async () => ({ transactionHash: "0xtx" }));
    const r = reputation(env, { giveFeedback } as never, {} as never);
    expect(await r.rate("0x65f8e30a61635afeb3f33b5221f05b8a6fce3e13", "flights", "http://a")).toBe(
      "0xtx",
    );
    expect(giveFeedback).toHaveBeenCalledWith(expect.anything(), 131n, 100, "flights", "http://a");
  });

  it("skips agents without an identity and never throws", async () => {
    const giveFeedback = vi.fn(async () => {
      throw new Error("reverted");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = reputation(env, { giveFeedback } as never, {} as never);
    expect(await r.rate("0x1111111111111111111111111111111111111111", "x", "e")).toBeNull();
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(await r.rate("0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13", "x", "e")).toBeNull();
    err.mockRestore();
  });
});
