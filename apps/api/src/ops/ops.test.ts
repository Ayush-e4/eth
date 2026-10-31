import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createSession, SESSION_COOKIE } from "../auth/session";
import type { Market, MarketAgent } from "../concierge/market";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { testDb } from "../test/db";
import { type HiddenAgents, hiddenAgentStore, visibleMarket } from "./hidden";

const ORIGIN = "http://localhost:3000";
const PACKPAL = "0x5fA59300b772d54451E6921c4A0Db8fd3DDad8ce";
const SKYHOP = "0x1bf6f94Ad76E0d0Af98cf99279c8BA22fE17211B";
const agent = (name: string, address: string, skill: string) =>
  ({ name, agent: address, skill, priceUnits: "10000", endpoint: "http://x" }) as MarketAgent;
const market: Market = {
  agents: async () => [agent("PackPal", PACKPAL, "packing"), agent("SkyHop", SKYHOP, "flights")],
};

let db: Db;
let hidden: HiddenAgents;
let admin: string;
let someone: string;

const newUser = async () =>
  ((await db.insert(users).values({ isDemo: true }).returning())[0]?.id ?? "") as string;

function app() {
  return createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ADMIN_USERS: admin }), {
    ops: {
      env: null,
      status: null,
      allAgents: {
        list: async () => ({
          agents: (await market.agents()).map((a) => ({
            ...a,
            up: true,
            jobsHere: 2,
            earnedHereUnits: "20000",
            lastJobAt: null,
          })),
        }),
      } as never,
      market,
      hidden,
      giftsPerDay: 20,
    },
  });
}

async function as(userId: string) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const a = app();
  return (method: string, path: string, body?: unknown) =>
    a.request(path, {
      method,
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(async () => {
  db = await testDb();
  hidden = hiddenAgentStore(db);
  admin = await newUser();
  someone = await newUser();
});

describe("ops page", () => {
  it("is for admins only, and tells a non-admin their account id", async () => {
    expect((await app().request("/ops")).status).toBe(401);
    const call = await as(someone);
    const res = await call("GET", "/ops");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ yourAccountId: someone });
    const hide = await call("POST", `/ops/agents/${PACKPAL}/hide`, { reason: "spam lists" });
    expect(hide.status).toBe(403);
    expect(hidden.isHidden(PACKPAL)).toBe(false);
  });

  it("shows an admin the people and agents, and hides an agent with a reason", async () => {
    const call = await as(admin);
    const me = (await (await call("GET", "/me")).json()) as { user: { roles: string[] } };
    expect(me.user.roles).toContain("admin");

    const ops = (await (await call("GET", "/ops")).json()) as {
      people: { users: number };
      agents: { name: string; hidden: unknown }[];
    };
    expect(ops.people.users).toBe(2);
    expect(ops.agents.map((a) => [a.name, a.hidden])).toEqual([
      ["PackPal", null],
      ["SkyHop", null],
    ]);

    expect((await call("POST", `/ops/agents/${PACKPAL}/hide`, { reason: "x" })).status).toBe(400);
    const hide = await call("POST", `/ops/agents/${PACKPAL}/hide`, { reason: "sends junk lists" });
    expect(hide.status).toBe(200);
    const after = (await (await call("GET", "/ops")).json()) as {
      agents: { name: string; hidden: { reason: string } | null }[];
    };
    expect(after.agents.find((a) => a.name === "PackPal")?.hidden?.reason).toBe("sends junk lists");
    expect((await call("POST", `/ops/agents/${PACKPAL}/unhide`)).status).toBe(200);
    expect(hidden.isHidden(PACKPAL)).toBe(false);
  });
});

describe("hiding an agent", () => {
  it("takes it out of the market everyone sees, and puts it back", async () => {
    const visible = visibleMarket(market, hidden);
    await hidden.hide(PACKPAL, "PackPal", "sends junk lists", admin);
    expect((await visible.agents()).map((a) => a.name)).toEqual(["SkyHop"]);
    expect(hidden.isHidden(PACKPAL.toLowerCase())).toBe(true); // any letter case
    await hidden.unhide(PACKPAL);
    expect((await visible.agents()).map((a) => a.name)).toEqual(["PackPal", "SkyHop"]);
  });
});
