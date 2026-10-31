import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { escrowReviews as table, users } from "../db/schema";
import { testDb } from "../test/db";
import type { EscrowBuyer } from "./env";
import { escrowReviews } from "./review";

const E1 = `0x${"e1".repeat(32)}`;
let db: Db;
let chatId: string;
let onChain: string;
let buyer: { [K in keyof EscrowBuyer]: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  chatId = (await chatStore(db).create(u as never)).id;
  onChain = "delivered";
  buyer = {
    release: vi.fn(async () => {
      onChain = "released";
      return "0xreleased";
    }),
    dispute: vi.fn(async () => {
      if (onChain !== "delivered") throw new Error("WrongEscrowState");
      onChain = "disputed";
      return "0xdisputed";
    }),
    read: vi.fn(async () => ({ state: onChain })),
  };
});

const reviews = (seconds = 60) => escrowReviews(db, buyer as unknown as EscrowBuyer, seconds);
const row = async () => (await db.select().from(table).where(eq(table.escrowId, E1)))[0];

describe("held for the user's review", () => {
  it("pays the agent when the review window ends", async () => {
    const r = reviews(0.05);
    await r.hold(chatId, E1, "PackPal");
    expect(await r.status(chatId, E1)).toMatchObject({ status: "holding", onChain: "delivered" });
    await vi.waitFor(async () => expect((await row())?.status).toBe("released"));
    expect(await row()).toMatchObject({ releasedTx: "0xreleased" });
    expect(buyer.release).toHaveBeenCalledOnce();
  });

  it("pay now: paid at once, and the timer doesn't pay twice", async () => {
    const r = reviews(0.05);
    await r.hold(chatId, E1, "PackPal");
    expect(await r.release(E1)).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 120));
    expect(buyer.release).toHaveBeenCalledOnce();
  });

  it("a dispute freezes it: the timer never pays; the user can still pay anyway", async () => {
    const r = reviews(0.05);
    await r.hold(chatId, E1, "PackPal");
    expect(await r.dispute(E1)).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 120));
    expect(buyer.release).not.toHaveBeenCalled();
    expect(await r.status(chatId, E1)).toMatchObject({ status: "disputed", onChain: "disputed" });
    expect(await r.dispute(E1)).toMatchObject({ ok: false }); // once is enough
    expect(await r.release(E1)).toEqual({ ok: true }); // "pay anyway"
    expect((await row())?.status).toBe("released");
  });

  it("a click and the timer can't both act", async () => {
    const r = reviews();
    await r.hold(chatId, E1, "PackPal");
    const [a, b] = await Promise.all([r.release(E1), r.dispute(E1)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("a dispute the chain refuses (not delivered yet) leaves it waiting, timer and all", async () => {
    onChain = "held";
    const r = reviews(0.2);
    await r.hold(chatId, E1, "PackPal");
    expect(await r.dispute(E1)).toMatchObject({ ok: false });
    expect((await row())?.status).toBe("holding");
    await vi.waitFor(async () => expect((await row())?.status).toBe("released"));
  });

  it("refunded by the agent after a dispute: paying anyway says so", async () => {
    const r = reviews();
    await r.hold(chatId, E1, "PackPal");
    await r.dispute(E1);
    onChain = "refunded";
    buyer.release.mockRejectedValueOnce(new Error("WrongEscrowState"));
    expect(await r.release(E1)).toMatchObject({ ok: false });
    expect((await row())?.status).toBe("refunded");
  });

  it("after a restart: a dispute that went through is never paid out by the timer", async () => {
    await reviews().hold(chatId, E1, "PackPal");
    await db
      .update(table)
      .set({ status: "disputing", releaseAt: new Date(Date.now() - 1000) })
      .where(eq(table.escrowId, E1));
    onChain = "disputed";
    await reviews().resume();
    await new Promise((res) => setTimeout(res, 50));
    expect((await row())?.status).toBe("disputed");
    expect(buyer.release).not.toHaveBeenCalled();
  });

  it("after a restart: an overdue fee is paid out, and another chat can't see it", async () => {
    await reviews().hold(chatId, E1, "PackPal");
    await db.update(table).set({ releaseAt: new Date(Date.now() - 1000) });
    const r = reviews();
    expect(await r.resume()).toBe(1);
    await vi.waitFor(async () => expect((await row())?.status).toBe("released"));
    expect(await r.status("00000000-0000-0000-0000-000000000000", E1)).toBeNull();
  });
});
