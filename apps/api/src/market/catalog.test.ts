import { agentRecords, deliveriesBy, liveTasks } from "@eth/arkiv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { hires, users } from "../db/schema";
import { testDb } from "../test/db";
import { marketCatalog } from "./catalog";
import { marketRoutes } from "./routes";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  agentRecords: vi.fn(),
  deliveriesBy: vi.fn(),
  liveTasks: vi.fn(),
}));

const SKY = "0xa21eEE5C2EFb86F3737Cb92D08276a45d03daF5E";
const AIR = "0x65F8E30A61635aFEB3F33b5221f05b8a6fCE3e13";
const agent = (name: string, address: string, priceUnits: string) => ({
  name,
  skill: "flights",
  title: `${name} — flights`,
  description: "books flights",
  priceUnits,
  agent: address,
  endpoint: `http://${name.toLowerCase()}`,
});
const market = {
  agents: async () => [agent("SkyHop", SKY, "50000"), agent("AirNest", AIR, "30000")],
};
const status = {
  get: async () => ({
    services: [
      { name: "SkyHop", ok: true },
      { name: "AirNest", ok: false },
    ],
  }),
};

let db: Db;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(liveTasks).mockResolvedValue([
    { record: { status: "open" } },
    { record: { status: "awarded" } },
  ] as never);
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  const chat = await chatStore(db).create(u as never);
  const hire = (a: string, feeUnits: bigint) =>
    db.insert(hires).values({
      chatId: chat.id,
      mandateId: 1n,
      registry: "0xreg",
      skill: "flights",
      agent: a,
      title: "x",
      feeUnits,
      hederaTx: `0.0.1@${Math.random()}`,
      jobKey: "0x",
    });
  await hire(SKY, 50_000n);
  await hire(SKY.toLowerCase(), 50_000n); // the same agent, however its address is written
});

const catalog = () =>
  marketCatalog(db, {
    market: market as never,
    status: status as never,
    reader: {} as never,
    fetchImpl: (async () =>
      Response.json({
        inputSchema: { properties: { origin: { type: "string" } }, required: ["origin"] },
      })) as never,
  });

describe("market catalog", () => {
  it("lists agents with health and what they did through AgentNet", async () => {
    const { agents, openTasks } = await catalog().list();
    expect(openTasks).toBe(1);
    expect(agents.map((a) => [a.name, a.up, a.jobsHere, a.earnedHereUnits])).toEqual([
      ["SkyHop", true, 2, "100000"],
      ["AirNest", false, 0, "0"],
    ]);
  });

  it("one agent in full: input, where it's paid, signed records and track record", async () => {
    vi.mocked(agentRecords).mockResolvedValue({
      profiles: [{ key: "0xprofile", record: { skill: "flights", hederaAccount: "0.0.11116426" } }],
      listings: [{ key: "0xlisting", record: { skill: "flights" } }],
    } as never);
    vi.mocked(deliveriesBy).mockResolvedValue([
      { key: "0xd1", record: { task: "t1", status: "delivered" } },
      { key: "0xd2", record: { task: "t2", status: "refunded", refundTx: "0.0.5@1.1" } },
    ] as never);
    const a = await catalog().agent(SKY.toLowerCase());
    expect(a).toMatchObject({
      name: "SkyHop",
      hederaAccount: "0.0.11116426",
      profileKey: "0xprofile",
      listingKey: "0xlisting",
      inputSchema: { required: ["origin"] },
      delivered: 1,
      refunded: 1,
    });
    expect(a?.deliveries[1]).toEqual({
      key: "0xd2",
      task: "t2",
      status: "refunded",
      refundTx: "0.0.5@1.1",
    });
    expect(await catalog().agent("0x0000000000000000000000000000000000000001")).toBeNull();
  });

  it("routes: public, and strict about addresses", async () => {
    vi.mocked(agentRecords).mockResolvedValue({ profiles: [], listings: [] } as never);
    vi.mocked(deliveriesBy).mockResolvedValue([]);
    const app = marketRoutes(catalog());
    expect((await app.request("/market")).status).toBe(200);
    expect((await app.request("/market/agents/nope")).status).toBe(400);
    expect(
      (await app.request("/market/agents/0x0000000000000000000000000000000000000001")).status,
    ).toBe(404);
    expect((await app.request(`/market/agents/${SKY}`)).status).toBe(200);
  });
});
