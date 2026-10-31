import { buy } from "@eth/agents/hiring";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { chats, hires, mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import { env } from "../test/hiring";
import { approvalBook } from "./approvals";
import { bookingDesk } from "./bookings";
import { hiringService } from "./service";

vi.mock("@eth/agents/hiring", async (real) => ({
  ...(await real<typeof import("@eth/agents/hiring")>()),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1 })),
}));
vi.mock("@eth/arkiv", () => ({ arkivReader: vi.fn(() => ({})), arkivWriter: vi.fn(() => ({})) }));

const SKYHOP = "0xa21eee5c2efb86f3737cb92d08276a45d03daf5e";
let db: Db;
let chat: Awaited<ReturnType<ReturnType<typeof chatStore>["create"]>>;
let userId: string;
let agentCalls: { path: string; body: unknown }[];

const hire = (skill: string, result: unknown, at: number) =>
  db.insert(hires).values({
    chatId: chat.id,
    mandateId: 7n,
    registry: env.registry.toLowerCase(),
    skill,
    agent: SKYHOP,
    endpoint: "http://skyhop",
    title: "SkyHop — cheapest flight",
    feeUnits: 50_000n,
    hederaTx: `0.0.1@${at}`,
    jobKey: "0xjob",
    result,
    createdAt: new Date(at),
  });

beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  userId = u?.id ?? "";
  chat = await chatStore(db).create(u as never);
  await db.update(chats).set({ mode: "auto" });
  chat = { ...chat, mode: "auto" };
  agentCalls = [];
  // The agent: answers as SkyHop's management routes do.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      agentCalls.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      if (path.startsWith("/bookings/h")) return hotelAgent(path);
      if (path.endsWith("/change-options"))
        return Response.json({
          current: "ZZ7426 BOM→GOI 2026-12-10 06:00",
          options: [
            {
              quoteKey: "0xchange1",
              note: "ZZ7426 BOM→GOI 2026-12-11 06:00: costs 125.00 GBP more",
              changeTotal: "125.00",
              penalty: "25.00",
              currency: "GBP",
            },
          ],
          changeFeeUsdc: 0.02,
          pay: { task: "trip-1", skill: "flights.change", input: { orderId: "ord_1" } },
        });
      if (path.endsWith("/cancel-quote"))
        return Response.json({
          quoteId: "ore_1",
          refund: "34.52",
          currency: "GBP",
          paid: "44.52",
          paidCurrency: "GBP",
        });
      return Response.json({ agent: "SkyHop", result: { cancelled: true } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** As StayWise's management routes answer ("hOLD" was rebooked by PriceGuard into "h2"). */
const hotelAgent = (path: string) =>
  path.startsWith("/bookings/hOLD/")
    ? Response.json({ error: "booking_replaced", replacedBy: "h2" }, { status: 409 })
    : path.endsWith("/view")
      ? Response.json({ booking: { total: 17815.68, currency: "INR" }, cancelFeeNow: 815.68 })
      : path.endsWith("/change-options")
        ? Response.json({
            current: { hotelName: "Park Inn" },
            options: [
              {
                quoteKey: "0xhchange",
                note: "Park Inn 13→16 Nov: 28,767 INR (+61% vs paid)",
                total: 28767.44,
                currency: "INR",
                priceDifferencePercent: 61,
              },
            ],
            changeFeeUsdc: 0.02,
            pay: { task: "trip-2", skill: "hotels.change", input: { bookingId: "h2" } },
          })
        : Response.json({ agent: "StayWise", result: { status: "CANCELLED" } });

describe("my bookings", () => {
  it("lists each booking once, as it stands after its changes; never someone else's", async () => {
    await hire("flights", { orderId: "ord_1", bookingReference: "VRUDTM" }, 1000);
    await hire("hotels", { bookingId: "h1", confirmationCode: "HC1" }, 2000);
    await hire("flights.change", { orderId: "ord_1", bookingReference: "VRUDTN" }, 3000);
    await hire("hotels.change", { bookingId: "h2", replaces: "h1", queued: false }, 4000);
    const desk = bookingDesk(db, env);
    expect(await desk.list(userId)).toEqual([
      expect.objectContaining({
        kind: "hotel",
        bookingId: "h2",
        bookingReference: "h2", // a hotel change is a new booking: its id
        changes: 1,
      }),
      expect.objectContaining({
        kind: "flight",
        bookingId: "ord_1",
        bookingReference: "VRUDTN",
        changes: 1,
      }),
    ]);
    const [other] = await db.insert(users).values({ isDemo: true }).returning();
    expect(await desk.list(other?.id ?? "")).toEqual([]);
    await expect(desk.view(other?.id ?? "", "VRUDTN")).rejects.toThrow("no such booking");
  });

  it("hotels: a dearer change needs approval; a cancel shows what comes back after the fee", async () => {
    await hire("hotels", { bookingId: "h1", confirmationCode: "HC1" }, 1000);
    await hire("hotels.change", { bookingId: "h2", replaces: "h1" }, 2000);
    const desk = bookingDesk(db, env);
    const out = await desk.changeOptions(userId, chat.id, "h2", {
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      adults: 2,
    });
    expect(agentCalls.at(-1)).toEqual({
      path: "/bookings/h2/change-options",
      body: { checkin: "2026-11-13", checkout: "2026-11-16", adults: 2 },
    });
    expect(out.held[0]?.option.confirm).toContain("61% more than what was paid");
    const asked = await desk.cancel(userId, chat.id, "h2");
    expect(asked).toMatchObject({
      card: {
        title: "Cancel hotel h2",
        detail: expect.stringContaining("17000 INR comes back of 17815.68"),
      },
    });
    await approvalBook(db).note(
      chat.id,
      `Approve ${asked.status === "needs_approval" ? asked.card.code : ""}`,
    );
    expect(await desk.cancel(userId, chat.id, "h2")).toMatchObject({ status: "cancelled" });
    expect(agentCalls.at(-1)).toEqual({ path: "/bookings/h2/cancel", body: {} });
  });

  it("a change that costs more at the airline needs the user's approval, even in Auto", async () => {
    await hire("flights", { orderId: "ord_1", bookingReference: "VRUDTM" }, 1000);
    await db.insert(mandates).values({
      chatId: chat.id,
      mandateId: 7n,
      registry: env.registry.toLowerCase(),
      owner: env.demo.evm,
      payer: "0.0.1001",
      budgetUnits: 300_000n,
      payees: [SKYHOP],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const out = await bookingDesk(db, env).changeOptions(userId, chat.id, "VRUDTM", {
      date: "2026-12-11",
    });
    expect(out.held[0]?.option).toMatchObject({ feeUnits: 20_000n, endpoint: "http://skyhop" });
    expect(out.held[0]?.option.confirm).toContain("125.00 GBP more");
    const s = hiringService(db, env);
    const asked = await s.hire(chat, out.held[0]?.ref ?? "", "move it", "change");
    expect(asked).toMatchObject({ status: "needs_approval" });
    expect(buy).not.toHaveBeenCalled();
  });

  it("cancels only after the user approved the card with the refund", async () => {
    await hire("flights", { orderId: "ord_1", bookingReference: "VRUDTM" }, 1000);
    const desk = bookingDesk(db, env);
    const first = await desk.cancel(userId, chat.id, "VRUDTM");
    expect(first).toMatchObject({
      status: "needs_approval",
      card: { title: "Cancel flight VRUDTM", detail: expect.stringContaining("34.52 GBP") },
    });
    expect(agentCalls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
    const code = first.status === "needs_approval" ? first.card.code : "";
    await approvalBook(db).note(chat.id, `Approve ${code}`);
    expect(await desk.cancel(userId, chat.id, "VRUDTM")).toEqual({
      status: "cancelled",
      refund: "34.52",
      currency: "GBP",
    });
    expect(agentCalls.at(-1)).toEqual({
      path: "/bookings/ord_1/cancel",
      body: { quoteId: "ore_1" },
    });
    // the approval was used up: another cancel asks again
    expect(await desk.cancel(userId, chat.id, "VRUDTM")).toMatchObject({
      status: "needs_approval",
    });
  });

  it("follows a hotel rebooked outside a hire (PriceGuard) to the booking now", async () => {
    await hire("hotels", { bookingId: "hOLD" }, 1000);
    const desk = bookingDesk(db, env);
    expect(await desk.find(userId, "hOLD")).toMatchObject({
      bookingId: "h2",
      bookingReference: "h2",
      now: { total: 17815.68 }, // what StayWise says about the booking now
    });
    await desk.changeOptions(userId, chat.id, "hOLD", {
      checkin: "2026-12-08",
      checkout: "2026-12-11",
    });
    expect(agentCalls.at(-1)?.path).toBe("/bookings/h2/change-options");
  });
});
