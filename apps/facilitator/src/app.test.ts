import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const facilitator = {
  supported: () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet" }] }),
  verify: async () => ({ isValid: true, payer: "0.0.1" }),
  settle: async () => ({
    success: true,
    transaction: "0.0.9@1.2",
    network: "hedera:testnet" as const,
  }),
};
const app = createApp(facilitator as never);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const valid = { x402Version: 2, paymentPayload: {}, paymentRequirements: {} };

describe("facilitator HTTP", () => {
  it("advertises supported kinds", async () => {
    const res = await app.request("/supported");
    expect(((await res.json()) as { kinds: unknown[] }).kinds).toHaveLength(1);
  });

  it("verifies and settles x402 v2 bodies", async () => {
    expect(await (await post("/verify", valid)).json()).toMatchObject({ isValid: true });
    expect(await (await post("/settle", valid)).json()).toMatchObject({ success: true });
  });

  it("rejects malformed bodies with 400", async () => {
    expect((await post("/verify", { x402Version: 1 })).status).toBe(400);
    expect((await post("/settle", "not json")).status).toBe(400);
  });
});
