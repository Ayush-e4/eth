import { describe, expect, it } from "vitest";
import { Mirror, parseAccount, parseMessages } from "./mirror";

describe("mirror parsing", () => {
  it("parses account balances", () => {
    const b = parseAccount({
      account: "0.0.5",
      evm_address: "0xabc",
      balance: { balance: 250_000_000, tokens: [{ token_id: "0.0.429274", balance: 2_000_000 }] },
    });
    expect(b.tinybars).toBe(250_000_000n);
    expect(b.tokens["0.0.429274"]).toBe(2_000_000n);
  });

  it("decodes base64 topic messages", () => {
    const [m] = parseMessages({
      messages: [
        {
          sequence_number: 3,
          consensus_timestamp: "1.2",
          message: Buffer.from('{"a":1}').toString("base64"),
        },
      ],
    });
    expect(m?.text).toBe('{"a":1}');
    expect(m?.sequence).toBe(3);
  });

  it("surfaces HTTP errors", async () => {
    const mirror = new Mirror("https://x", async () => new Response("nope", { status: 404 }));
    await expect(mirror.balances("0.0.1")).rejects.toThrow(/HTTP 404/);
  });
});
