import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { limitCard } from "./mandates";
import type { HiringService } from "./service";

const ORIGIN = "http://localhost:3000";
const USER = "0x7a3F00000000000000000000000000000000091C";
const CONCIERGE = "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8";
const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const USDC = "0x0000000000000000000000000000000000068cda";

const onchain = {
  owner: USER,
  agent: CONCIERGE,
  token: USDC,
  budget: 300_000n,
  revoked: false,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const getMandate = vi.fn();
const isPayeeAllowed = vi.fn();
const logWrite = vi.fn(async () => 5);
const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: CONCIERGE },
  demo: {
    key: `0x${"22".repeat(32)}`,
    evm: "0x0000000000000000000000000000000000000d3d",
    account: "0.0.1001",
  },
  mc: {
    getMandate,
    remaining: vi.fn(async () => 270_000n),
    publicClient: { readContract: isPayeeAllowed },
    chain: { id: 296 },
  },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  usdc: USDC,
  usdcTokenId: "0.0.429274",
  mirrorUrl: "https://mirror",
  log: { topicId: "0.0.99", write: logWrite },
} as unknown as HiringEnv;

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;
let chatId: string;

const req = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  vi.clearAllMocks();
  getMandate.mockResolvedValue(onchain);
  isPayeeAllowed.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ account: "0.0.7777" })),
  );
  db = await testDb();
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    hiring: { env, service: { noteUserMessage: () => {} } as unknown as HiringService },
  });
  // Sign in through the demo route, then make that user a wallet user.
  const res = await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } });
  cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  await db.update(users).set({ isDemo: false, address: USER });
  chatId = ((await (await req("POST", "/chats")).json()) as { chat: { id: string } }).chat.id;
});

const card = () => limitCard(env, 300_000n, [{ name: "AirNest", agent: AIRNEST }]);

describe("adopting a wallet user's mandate", () => {
  it("accepts a mandate the chain says is theirs, for our concierge, allowing the agents", async () => {
    const res = await req("POST", `/chats/${chatId}/mandate`, { mandateId: "42", card: card() });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      mandate: { mandateId: "42", payer: "0.0.7777", demo: false },
    });
    const now = (await (await req("GET", `/chats/${chatId}/mandate`)).json()) as {
      mandate: unknown;
    };
    expect(now.mandate).toMatchObject({ mandateId: "42", remainingUnits: "270000" });
  });

  it("writes the new limit to the public spend log", async () => {
    await req("POST", `/chats/${chatId}/mandate`, { mandateId: "42", card: card() });
    expect(logWrite).toHaveBeenCalledWith({
      kind: "agentnet.mandate.created",
      mandateId: "42",
      owner: USER,
      budget: "300000",
      payees: [AIRNEST],
      expiresAt: Number(onchain.expiresAt),
      via: "wallet",
    });
    const [row] = await db.select().from(mandates);
    expect(row?.logSeq).toBe(5);
  });

  it.each([
    [
      "someone else's",
      { owner: "0x1111111111111111111111111111111111111111" },
      "that mandate isn't yours",
    ],
    [
      "for another agent",
      { agent: "0x2222222222222222222222222222222222222222" },
      "the concierge isn't its agent",
    ],
    [
      "in another token",
      { token: "0x3333333333333333333333333333333333333333" },
      "it doesn't pay in USDC",
    ],
    ["revoked", { revoked: true }, "it's revoked or expired"],
  ])("refuses a mandate that's %s", async (_, change, error) => {
    getMandate.mockResolvedValue({ ...onchain, ...change });
    const res = await req("POST", `/chats/${chatId}/mandate`, { mandateId: "42", card: card() });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error });
  });

  it("refuses one that doesn't allow an agent the user was asked about", async () => {
    isPayeeAllowed.mockResolvedValue(false);
    const res = await req("POST", `/chats/${chatId}/mandate`, { mandateId: "42", card: card() });
    expect(await res.json()).toEqual({ error: "it doesn't allow paying AirNest" });
  });

  it("refuses an edited card and the demo wallet for wallet users", async () => {
    const edited = { ...card(), budgetUnits: "5000000" };
    expect(
      (await req("POST", `/chats/${chatId}/mandate`, { mandateId: "42", card: edited })).status,
    ).toBe(409);
    expect(
      (await req("POST", `/chats/${chatId}/mandate`, { demo: true, card: card() })).status,
    ).toBe(403);
  });
});
