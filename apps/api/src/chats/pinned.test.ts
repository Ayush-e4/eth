import { buy, collectQuotes } from "@eth/agents/hiring";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { Concierge, ConciergeInput } from "../concierge/concierge";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { mandates } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { hiringService } from "../hiring/service";
import { testDb } from "../test/db";

vi.mock("@eth/agents/hiring", () => ({
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1, USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({ arkivReader: vi.fn(() => ({})), arkivWriter: vi.fn(() => ({})) }));

const ORIGIN = "http://localhost:3000";
const SKY = "0xa21eEE5C2EFb86F3737Cb92D08276a45d03daF5E";
const AIR = "0x65F8E30A61635aFEB3F33b5221f05b8a6fCE3e13";
const catalog = {
  list: async () => ({ agents: [{ agent: SKY, name: "SkyHop", skill: "flights" }], openTasks: 0 }),
};
let db: Db;
let app: ReturnType<typeof createApp>;
let seen: ConciergeInput[];
const concierge: Concierge = async (input) => {
  seen.push(input);
  return { text: "ok", cards: [] };
};

beforeEach(async () => {
  vi.clearAllMocks();
  seen = [];
  db = await testDb();
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    concierge,
    catalog: catalog as never,
  });
});
const req = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const signIn = async () =>
  (await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } })).headers
    .get("set-cookie")
    ?.split(";")[0] ?? "";

describe("a chat with one agent", () => {
  it("starts from a listed agent, tells the concierge, and can be widened again", async () => {
    const me = await signIn();
    expect((await req("POST", "/chats", me, { agent: "nope" })).status).toBe(400);
    expect((await req("POST", "/chats", me, { agent: AIR })).status).toBe(404); // not listed
    const res = await req("POST", "/chats", me, { agent: SKY });
    expect(res.status).toBe(201);
    const { chat } = (await res.json()) as {
      chat: { id: string; title: string; agent: { address: string; name: string } };
    };
    expect(chat).toMatchObject({
      title: "Chat with SkyHop",
      agent: { address: SKY, name: "SkyHop", skill: "flights" },
    });

    await (
      await req("POST", `/chats/${chat.id}/messages`, me, { text: "BOM to GOI on 4 Dec" })
    ).text();
    expect(seen[0]?.chat).toMatchObject({
      agentAddress: SKY,
      agentName: "SkyHop",
      agentSkill: "flights",
    });
    const title = (await (await req("GET", `/chats/${chat.id}`, me)).json()) as {
      chat: { title: string };
    };
    expect(title.chat.title).toBe("Chat with SkyHop"); // the first message doesn't rename it

    const widened = (await (
      await req("PATCH", `/chats/${chat.id}`, me, { agent: null })
    ).json()) as {
      chat: { agent: unknown };
    };
    expect(widened.chat.agent).toBeNull();
  });
});

describe("hiring in a chat with one agent", () => {
  const env = {
    concierge: { key: `0x${"11".repeat(32)}`, evm: "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8" },
    demo: { key: `0x${"22".repeat(32)}`, evm: "0x0000000000000000000000000000000000000d3d" },
    mc: { publicClient: {}, chain: { id: 296 } },
    registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
    registryId: "0.0.11102395",
    mirrorUrl: "https://mirror",
  } as unknown as HiringEnv;
  const option = (agent: string, key: string) => ({
    key,
    agent,
    title: "x — y",
    note: "n",
    feeUnits: 30_000n,
    endpoint: "http://a",
  });

  it("asks only that agent, and refuses to pay anyone else", async () => {
    const me = await signIn();
    const { chat } = (await (await req("POST", "/chats", me, { agent: SKY })).json()) as {
      chat: { id: string };
    };
    await db.insert(mandates).values({
      chatId: chat.id,
      mandateId: 7n,
      owner: env.demo.evm,
      payer: "0.0.1001",
      budgetUnits: 300_000n,
      payees: [SKY, AIR],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // Even if a round somehow held another agent's quote, it can't be paid in this chat.
    vi.mocked(collectQuotes).mockResolvedValue({
      skill: "flights",
      task: "t",
      input: {},
      options: [option(AIR, "0xqa")],
      bestReason: "",
      skipped: [],
    } as never);
    const s = hiringService(db, env);
    const pinned = { id: chat.id, mode: "auto" as const, limitUnits: 300_000n, agentAddress: SKY };
    await s.quotes(pinned, "flights", {});
    expect(vi.mocked(collectQuotes).mock.calls[0]?.[3]).toMatchObject({ only: SKY });
    const out = await s.hire(pinned, "q1", "x", "flights");
    expect(out).toMatchObject({ status: "refused" });
    expect(buy).not.toHaveBeenCalled();
  });
});
