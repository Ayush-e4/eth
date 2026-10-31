import { cancelMessage } from "@eth/x402";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { chats, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { undoWindows } from "./undo";

const key = generatePrivateKey();
const env = { concierge: { key }, mirrorUrl: "https://mirror" } as unknown as HiringEnv;
const soon = () => Date.now() + 60_000;

/** A facilitator that knows one schedule (until it "restarts") and records cancels. */
function fakeFacilitator(executesAt = soon(), appearsAfter = 0) {
  let calls = 0;
  const f = {
    forgot: false,
    cancels: [] as { id: string; signature: string }[],
    scheduled: async (k: string) =>
      !f.forgot && calls++ >= appearsAfter && k === "0xkey"
        ? { scheduleId: "0.0.700", executesAt, status: "scheduled" as const }
        : null,
    cancelScheduled: async (id: string, signature: string) => {
      if (f.forgot) return { ok: false, reason: "no such scheduled payment" };
      f.cancels.push({ id, signature });
      return { ok: true };
    },
  };
  return f;
}
const mirror = (body: object) => (async () => Response.json(body)) as unknown as typeof fetch;

let db: Db;
let chatA: string;
let chatB: string;
beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  const made = await db
    .insert(chats)
    .values([
      { userId: u?.id ?? "", title: "a" },
      { userId: u?.id ?? "", title: "b" },
    ])
    .returning();
  chatA = made[0]?.id ?? "";
  chatB = made[1]?.id ?? "";
});

const undo = (f: ReturnType<typeof fakeFacilitator>, fetchImpl = mirror({})) =>
  undoWindows(db, env, 60, { facilitator: f, wait: async () => {}, fetchImpl });

describe("undo windows", () => {
  it("finds the schedule for a signed payment and reports it to its chat", async () => {
    const at = soon();
    const f = fakeFacilitator(at, 2);
    const seen: unknown[] = [];
    await undo(f).watch(chatA, "0xkey", (s) => seen.push(s));
    expect(seen).toEqual([{ scheduleId: "0.0.700", executesAt: at }]);
    expect(await undo(f).status(chatA, "0.0.700")).toMatchObject({ status: "scheduled" });
  });

  it("only the chat that made a payment can see or cancel it", async () => {
    const f = fakeFacilitator();
    await undo(f).watch(chatA, "0xkey", () => {});
    expect(await undo(f).status(chatB, "0.0.700")).toBeNull();
    expect(await undo(f).cancel(chatB, "0.0.700")).toMatchObject({ ok: false });
    expect(f.cancels).toEqual([]);
  });

  it("cancels with the concierge's signature", async () => {
    const f = fakeFacilitator();
    await undo(f).watch(chatA, "0xkey", () => {});
    expect(await undo(f).cancel(chatA, "0.0.700")).toEqual({ ok: true });
    const signer = await recoverMessageAddress({
      message: cancelMessage("0.0.700"),
      signature: f.cancels[0]?.signature as `0x${string}`,
    });
    expect(signer).toBe(privateKeyToAccount(key).address);
    expect(await undo(f).status(chatA, "0.0.700")).toMatchObject({ status: "cancelled" });
  });
});

describe("undo windows across a restart", () => {
  it("a new instance still knows the payment; Hedera answers once the facilitator forgot it", async () => {
    const f = fakeFacilitator(Date.now() - 1_000);
    await undo(f).watch(chatA, "0xkey", () => {});
    f.forgot = true; // the facilitator restarted
    const after = undo(f, mirror({ deleted: false, executed_timestamp: "1793446527.0" }));
    expect(await after.status(chatA, "0.0.700")).toMatchObject({ status: "executed" });
    // settled for good: no need to ask again
    expect(await undo(f, mirror({})).status(chatA, "0.0.700")).toMatchObject({
      status: "executed",
    });
  });

  it("recover() cancels payments left in their window by the last run", async () => {
    const f = fakeFacilitator();
    await undo(f).watch(chatA, "0xkey", () => {});
    expect(await undo(f).recover()).toBe(1);
    expect(f.cancels.map((c) => c.id)).toEqual(["0.0.700"]);
    expect(await undo(f).status(chatA, "0.0.700")).toMatchObject({ status: "cancelled" });
    expect(await undo(f).recover()).toBe(0); // nothing left open
  });

  it("recover() takes Hedera's word when the facilitator already deleted it", async () => {
    const f = fakeFacilitator();
    await undo(f).watch(chatA, "0xkey", () => {});
    f.forgot = true;
    await undo(f, mirror({ deleted: true })).recover();
    expect(await undo(f).status(chatA, "0.0.700")).toMatchObject({ status: "cancelled" });
  });
});
