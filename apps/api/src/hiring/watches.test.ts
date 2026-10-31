import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { chats, fareWatches, messages, users } from "../db/schema";
import { testDb } from "../test/db";
import { env } from "../test/hiring";
import type { HiringService } from "./service";
import { fareWatchFollower, type WatchView } from "./watches";

let db: Db;
let chatId: string;
let view: WatchView;
let calls: string[];

const check = (price: number, simulated?: boolean) => ({
  at: "2026-11-01T10:00:00Z",
  price,
  flight: "IndiGo 6E5061 BOM→GOX",
  ...(simulated ? { simulated } : {}),
});
const agentFetch = (async (url: string) => {
  calls.push(new URL(url).pathname);
  return Response.json({ watch: view });
}) as unknown as typeof fetch;
const hire = {
  skill: "farewatch",
  agent: "0xfw",
  agentTitle: "FareWatch — fares",
  endpoint: "http://farewatch",
  result: { watchId: "0xw1" },
} as never;
const said = async () =>
  (await db.select().from(messages).where(eq(messages.chatId, chatId))).map((m) => m.text);

beforeEach(async () => {
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  chatId = (await chatStore(db).create(u as never)).id;
  calls = [];
  view = {
    input: {
      origin: "BOM",
      destination: "GOI",
      date: "2026-12-04",
      adults: 1,
      targetInr: 3000,
      autoBook: true,
    },
    until: "2026-11-04T10:00:00Z",
    status: "watching",
    baseline: check(3267),
    lowest: check(3267),
    checks: [check(3267)],
    alerts: [],
  };
});

describe("following fare watches", () => {
  it("follows a FareWatch hire with a live card; posts each alert once, with Book it", async () => {
    const f = fareWatchFollower(db, env, { fetchImpl: agentFetch });
    expect(await f.add(chatId, { ...(hire as object), skill: "flights" } as never)).toBeNull();
    expect(await f.add(chatId, hire)).toEqual({
      type: "watch",
      watchId: "0xw1",
      title: "FareWatch",
    });
    view = {
      ...view,
      alerts: [{ ...check(3100), was: 3267, reason: "5% under the lowest so far" }],
    };
    await Promise.all([f.tick(), f.status(chatId, "0xw1"), f.tick()]); // racing: posted once
    expect(await said()).toEqual([expect.stringContaining("is now ₹3,100, 5% under the lowest")]);
    const [m] = await db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(m?.cards[0]).toMatchObject({
      type: "options",
      options: [{ label: "Book it" }, { label: "Keep watching" }],
    });
    expect(await f.status("00000000-0000-0000-0000-000000000000", "0xw1")).toBeNull();
  });

  it("at the target, in an Auto chat that asked for it: books the cheapest fare under it", async () => {
    await db.update(chats).set({ mode: "auto" });
    const quotes = vi.fn(async () => ({
      refs: [
        {
          ref: "q1",
          option: { note: "AirNest 6E5061", priced: { itemInr: 2990, totalInr: 2993 } },
        },
        { ref: "q2", option: { note: "SkyHop ZZ", priced: { itemInr: 3500, totalInr: 3505 } } },
      ],
    }));
    const hireIt = vi.fn(async () => ({
      status: "hired",
      card: { type: "hired", title: "AirNest" },
    }));
    const hiring = { quotes, hire: hireIt } as unknown as HiringService;
    const f = fareWatchFollower(db, env, { fetchImpl: agentFetch, hiring: () => hiring });
    await f.add(chatId, hire);
    view = {
      ...view,
      alerts: [{ ...check(2990), was: 3267, reason: "at or below your target of ₹3,000" }],
    };
    await f.tick();
    expect(quotes).toHaveBeenCalledWith(
      expect.objectContaining({ id: chatId }),
      "flights",
      expect.objectContaining({
        origin: "BOM",
        departDate: "2026-12-04",
        returnFlight: false,
        budgetInr: 3000,
      }),
    );
    expect(hireIt).toHaveBeenCalledWith(
      expect.anything(),
      "q1",
      expect.any(String),
      expect.any(String),
    );
    expect(await said()).toContain("Booked it, as you asked: AirNest 6E5061.");
    const [row] = await db.select().from(fareWatches);
    expect(row?.status).toBe("booked");
    expect(calls).toContain("/watches/0xw1/stop");
  });

  it("never books on a simulated drop, or in a chat that asks first", async () => {
    const hireIt = vi.fn();
    const hiring = {
      quotes: vi.fn(async () => ({ refs: [] })),
      hire: hireIt,
    } as unknown as HiringService;
    const f = fareWatchFollower(db, env, { fetchImpl: agentFetch, hiring: () => hiring });
    await f.add(chatId, hire);
    await db.update(chats).set({ mode: "auto" });
    view = { ...view, alerts: [{ ...check(2900, true), was: 3267, reason: "11% under" }] };
    await f.tick();
    expect(await said()).toEqual([expect.stringContaining("SIMULATED drop")]);
    await db.update(chats).set({ mode: "ask" });
    view = {
      ...view,
      alerts: [...view.alerts, { ...check(2950), was: 2900, reason: "at target" }],
    };
    await f.tick();
    expect(hireIt).not.toHaveBeenCalled();
  });
});
