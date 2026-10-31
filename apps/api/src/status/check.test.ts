import { describe, expect, it, vi } from "vitest";
import type { HiringEnv } from "../hiring/env";
import { testDb } from "../test/db";
import { statusCheck } from "./check";

const env = {
  mirrorUrl: "https://mirror",
  usdcTokenId: "0.0.429274",
  demo: { account: "0.0.1001" },
} as unknown as HiringEnv;
const market = {
  agents: async () => [
    { name: "SkyHop", skill: "flights", endpoint: "http://skyhop" },
    { name: "AirNest", skill: "flights", endpoint: "http://airnest" },
  ],
};
const fetchWith = (o: { down?: string[]; usdc?: number; hbar?: number }) =>
  vi.fn(async (url: string) => {
    if (o.down?.some((d) => url.startsWith(d))) throw new Error("ECONNREFUSED");
    if (url.includes("/balances"))
      return Response.json({
        balances: [
          {
            balance: o.hbar ?? 900e8,
            tokens: [{ token_id: "0.0.429274", balance: o.usdc ?? 15_000_000 }],
          },
        ],
      });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;

describe("status", () => {
  it("everything up and funded", async () => {
    const s = statusCheck(await testDb(), env, {
      market: market as never,
      facilitatorUrl: "http://fac",
      reader: { getBlockNumber: async () => 123n } as never,
      fetchImpl: fetchWith({}),
    });
    const v = await s.get();
    expect(v.ok).toBe(true);
    expect(v.services.map((p) => [p.name, p.ok])).toEqual([
      ["Payment service (x402 facilitator)", true],
      ["SkyHop", true],
      ["AirNest", true],
    ]);
    expect(v.networks.find((n) => n.name.startsWith("Arkiv"))).toMatchObject({
      ok: true,
      detail: "block 123",
    });
    expect(await s.demoUsdc()).toBe(15_000_000n);
  });

  it("names what's down, warns when the wallet runs low, and caches for 30 s", async () => {
    const fetchImpl = fetchWith({ down: ["http://airnest"], usdc: 400_000, hbar: 5e8 });
    const s = statusCheck(await testDb(), env, {
      market: market as never,
      facilitatorUrl: "http://fac",
      reader: { getBlockNumber: async () => Promise.reject(new Error("down")) } as never,
      fetchImpl,
    });
    const v = await s.get();
    expect(v.ok).toBe(false);
    expect(v.services.find((p) => p.name === "AirNest")?.ok).toBe(false);
    expect(v.networks.find((n) => n.name.startsWith("Arkiv"))?.ok).toBe(false);
    expect(v.wallet?.warnings).toEqual([
      "test USDC is low: top it up at faucet.circle.com",
      "HBAR for network fees is low: top it up at portal.hedera.com",
    ]);
    const calls = vi.mocked(fetchImpl).mock.calls.length;
    await s.get();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls); // served from the cache
  });
});
