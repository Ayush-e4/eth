import { cancelMessage, type HttpFacilitator } from "@eth/x402";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { HiringEnv } from "./env";
import { undoWindows } from "./undo";

const key = generatePrivateKey();
const env = { concierge: { key } } as unknown as HiringEnv;

function fakeFacilitator(appearsAfter = 0) {
  let calls = 0;
  const cancels: { id: string; signature: `0x${string}` }[] = [];
  const f = {
    cancels,
    scheduled: async (k: string) =>
      calls++ >= appearsAfter && k === "0xkey"
        ? { scheduleId: "0.0.700", executesAt: 1_000, status: "scheduled" as const }
        : null,
    cancelScheduled: async (id: string, signature: `0x${string}`) => {
      cancels.push({ id, signature });
      return { ok: true };
    },
  };
  return f;
}

describe("undo windows", () => {
  it("finds the schedule for a signed payment and reports it to its chat", async () => {
    const f = fakeFacilitator(2);
    const undo = undoWindows(env, 60, f as unknown as HttpFacilitator, async () => {});
    const seen: unknown[] = [];
    await undo.watch("chat-1", "0xkey", (s) => seen.push(s));
    expect(seen).toEqual([{ scheduleId: "0.0.700", executesAt: 1_000 }]);
    expect(await undo.status("chat-1", "0.0.700")).toMatchObject({ status: "scheduled" });
  });

  it("only the chat that made a payment can see or cancel it", async () => {
    const f = fakeFacilitator();
    const undo = undoWindows(env, 60, f as unknown as HttpFacilitator, async () => {});
    await undo.watch("chat-1", "0xkey", () => {});
    expect(await undo.status("chat-2", "0.0.700")).toBeNull();
    expect(await undo.cancel("chat-2", "0.0.700")).toMatchObject({ ok: false });
    expect(f.cancels).toEqual([]);
  });

  it("cancels with the concierge's signature", async () => {
    const f = fakeFacilitator();
    const undo = undoWindows(env, 60, f as unknown as HttpFacilitator, async () => {});
    await undo.watch("chat-1", "0xkey", () => {});
    expect(await undo.cancel("chat-1", "0.0.700")).toEqual({ ok: true });
    const [c] = f.cancels;
    const signer = await recoverMessageAddress({
      message: cancelMessage("0.0.700"),
      signature: c?.signature as `0x${string}`,
    });
    expect(signer).toBe(privateKeyToAccount(key).address);
  });
});
