import { checkInvoice } from "@eth/agents/hiring";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { fareWatches, messages, users } from "../db/schema";
import { testDb } from "../test/db";
import { env } from "../test/hiring";
import type { BookingDesk } from "./bookings";
import { followHotel, type GuardView } from "./hotel-follow";
import { hotelGuard } from "./hotel-guard";

vi.mock("@eth/agents/hiring", async (real) => ({
  ...(await real<typeof import("@eth/agents/hiring")>()),
  checkInvoice: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  invoicesFor: vi.fn(async () => [{ key: INV, record: {} }]),
}));

const STAY = "0x78ef54682bce53b3eb9bf9432952423aaa274ad1";
const PG = "0x5bcaea2aa1959059d894cc943de11f58053e6e6c";
const INV = `0x${"ab".repeat(32)}`;
let db: Db;
let chat: Awaited<ReturnType<ReturnType<typeof chatStore>["create"]>>;
let userId: string;
let posted: { path: string; body: Record<string, unknown> }[];
let view: GuardView;

const desk = {
  find: vi.fn(async () => ({
    id: "hire1",
    kind: "hotel",
    bookingId: "b1",
    bookingReference: "b1",
    agent: STAY,
    endpoint: "http://stay",
  })),
  view: vi.fn(async () => ({
    booking: { hotelName: "Park Inn", checkin: "2026-12-04", checkout: "2026-12-06" },
  })),
} as unknown as BookingDesk;

beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  userId = u?.id ?? "";
  chat = await chatStore(db).create(u as never);
  posted = [];
  view = {
    bookingId: "b2",
    status: "watching",
    limits: { minSavingInr: 500, minSavingPercent: 5, until: "2026-12-04" },
    checks: [],
    invoices: [{ key: INV, units: "2650000", saving: 1246, currency: "INR", paid: false }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      return Response.json(path === "/watch" ? { watching: true } : { watch: view });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const guard = () =>
  hotelGuard(db, env, {
    desk,
    findAgent: async () => ({ agent: PG, endpoint: "http://priceguard" }),
  });

describe("PriceGuard from the chat", () => {
  it("turns on with a slip signed by the concierge, and gives the chat a live card", async () => {
    const card = await guard().start(userId, chat.id, "b1", {
      minSavingInr: 500,
      minSavingPercent: 5,
    });
    expect(card).toEqual({
      type: "watch",
      watchId: "guard-b1",
      title: "PriceGuard",
      kind: "hotel",
    });
    const sent = posted.find((p) => p.path === "/watch")?.body as Record<string, never>;
    expect(sent).toMatchObject({ task: "guard-b1", bookingId: "b1", stayAgent: STAY });
    expect(sent.delegation).toMatchObject({
      signer: privateKeyToAccount(env.concierge.key).address, // the booking's buyer on Arkiv
      body: { bookingId: "b1", agent: STAY, delegate: PG, until: "2026-12-04" },
    });
    const [row] = await db.select().from(fareWatches);
    expect(row).toMatchObject({ kind: "hotel", input: { hotel: "Park Inn", minSavingInr: 500 } });
  });

  it("posts each rebook once, with Pay PriceGuard", async () => {
    await guard().start(userId, chat.id, "b1", { minSavingInr: 500, minSavingPercent: 5 });
    const [row] = await db.select().from(fareWatches);
    const say = async (chatId: string, text: string, cards: unknown[] = []) =>
      db.insert(messages).values({ chatId, role: "assistant", text, cards: cards as never });
    await Promise.all([
      followHotel(db, row as never, view, say),
      followHotel(db, row as never, view, say),
    ]);
    const said = await db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toContain("it saved 1,246 INR");
    expect(said[0]?.cards[0]).toMatchObject({
      options: [{ label: "Pay PriceGuard" }, { label: "Not now" }],
    });
  });

  it("pays only a checked invoice; a fee above the chat's limit asks for a limit just for it", async () => {
    await guard().start(userId, chat.id, "b1", { minSavingInr: 500, minSavingPercent: 5 });
    vi.mocked(checkInvoice).mockResolvedValueOnce({
      ok: false,
      reason: "the saving was SIMULATED (sandbox demo): no real money saved, so no fee is owed",
    });
    expect(await guard().pay(userId, chat, INV)).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("SIMULATED"),
    });
    vi.mocked(checkInvoice).mockResolvedValueOnce({
      ok: true,
      units: 2_650_000n,
      proof: {} as never,
    });
    const g = guard();
    const out = await g.pay(userId, chat, INV);
    expect(out).toMatchObject({
      status: "needs_limit",
      card: {
        budgetUnits: "2650000",
        perPaymentCapUnits: "2650000",
        payees: [{ name: "PriceGuard" }],
      },
    });
    // the limit route takes exactly the card it offered, and nothing else
    if (out.status !== "needs_limit") throw new Error("expected a limit card");
    expect(g.offered(chat.id, out.card)).toBe(true);
    expect(g.offered(chat.id, { ...out.card, budgetUnits: "9000000" })).toBe(false);
    expect(g.offered("another-chat", out.card)).toBe(false);
    expect(await guard().pay(userId, chat, `0x${"cd".repeat(32)}`)).toMatchObject({
      status: "refused",
    });
  });
});
