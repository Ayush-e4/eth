import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { hires, mandates } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import type { HiringService } from "../hiring/service";
import { testDb } from "../test/db";

const ORIGIN = "http://localhost:3000";
const AIRNEST = "0x65f8e30a61635afeb3f33b5221f05b8a6fce3e13";
const revoke = vi.fn(async () => ({}));
const getMandate = vi.fn(async () => ({
  budget: 300_000n,
  spent: 30_000n,
  revoked: false,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
}));
const logWrite = vi.fn(async () => 9);
const env = {
  log: { topicId: "0.0.99", write: logWrite },
  demo: {
    key: `0x${"22".repeat(32)}`,
    evm: "0x0000000000000000000000000000000000000d3d",
    account: "0.0.1001",
  },
  mc: { getMandate, revoke },
  mirrorUrl: "https://mirror",
  usdcTokenId: "0.0.429274",
} as unknown as HiringEnv;

let db: Db;
let app: ReturnType<typeof createApp>;

const req = (method: string, path: string, cookie: string) =>
  app.request(path, { method, headers: { cookie, origin: ORIGIN } });

async function demoUserWithAHire() {
  const res = await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const chat = ((await (await req("POST", "/chats", cookie)).json()) as { chat: { id: string } })
    .chat;
  await db.insert(mandates).values({
    chatId: chat.id,
    mandateId: 28n,
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees: [AIRNEST],
    payeeNames: { [AIRNEST]: "AirNest" },
    demo: true,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.insert(hires).values({
    chatId: chat.id,
    mandateId: 28n,
    skill: "flights",
    agent: AIRNEST,
    title: "AirNest — budget flights",
    feeUnits: 30_000n,
    hederaTx: "0.0.1001@1.2",
    jobKey: "0xjob",
    result: { reference: "FH-1" },
    logSeq: 34,
  });
  return { cookie, chatId: chat.id };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        balances: [
          { balance: 4_200_000_000, tokens: [{ token_id: "0.0.429274", balance: 9_620_000 }] },
        ],
      }),
    ),
  );
  db = await testDb();
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    hiring: { env, service: { noteUserMessage: () => {} } as unknown as HiringService },
  });
});

describe("tasks and wallet", () => {
  it("lists what agents did, with proof", async () => {
    const { cookie } = await demoUserWithAHire();
    const body = (await (await req("GET", "/tasks", cookie)).json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([
      expect.objectContaining({
        title: "AirNest",
        skill: "flights",
        feeUnits: "30000",
        hederaTx: "0.0.1001@1.2",
        result: { reference: "FH-1" },
        logSeq: 34,
      }),
    ]);
    expect(body).toMatchObject({ logTopic: "0.0.99" });
  });

  it("shows balances, limits as the chain sees them, and payments", async () => {
    const { cookie } = await demoUserWithAHire();
    const w = (await (await req("GET", "/wallet", cookie)).json()) as Record<string, unknown>;
    expect(w).toMatchObject({
      account: "0.0.1001",
      shared: true,
      balances: { usdcUnits: "9620000", hbarTinybars: "4200000000" },
      spentUnits: "30000",
      limits: [{ mandateId: "28", spentUnits: "30000", payees: ["AirNest"], status: "active" }],
      payments: [{ to: "AirNest", feeUnits: "30000" }],
    });
  });

  it("never shows another user's tasks, and won't revoke their limits", async () => {
    await demoUserWithAHire();
    const other =
      (await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } })).headers
        .get("set-cookie")
        ?.split(";")[0] ?? "";
    expect(await (await req("GET", "/tasks", other)).json()).toMatchObject({ tasks: [] });
    expect((await req("POST", "/wallet/limits/28/revoke", other)).status).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes a demo limit with the demo wallet, and leaves wallet users' limits to their wallet", async () => {
    const { cookie } = await demoUserWithAHire();
    expect((await req("POST", "/wallet/limits/28/revoke", cookie)).status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 28n);
    expect(logWrite).toHaveBeenCalledWith({
      kind: "agentnet.mandate.revoked",
      mandateId: "28",
      by: env.demo.evm,
    });
    await db.update(mandates).set({ demo: false });
    expect((await req("POST", "/wallet/limits/28/revoke", cookie)).status).toBe(409);
  });

  it("reads the public spend log back from the mirror node, no sign-in needed", async () => {
    const b64 = (v: unknown) =>
      Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        messages: [
          {
            sequence_number: 35,
            consensus_timestamp: "1793308077.058257691",
            message: b64({ kind: "x402.settled", amount: "30000" }),
          },
          {
            sequence_number: 1,
            consensus_timestamp: "1793300000.000000001",
            message: b64("hello"),
          },
        ],
      }),
    );
    const res = await app.request("/spend-log");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://mirror/api/v1/topics/0.0.99/messages?order=desc&limit=100",
    );
    expect(await res.json()).toEqual({
      topic: "0.0.99",
      entries: [
        { seq: 35, at: "2026-10-29T21:07:57.000Z", kind: "x402.settled", amount: "30000" },
        { seq: 1, at: "2026-10-29T18:53:20.000Z", kind: "note", text: "hello" },
      ],
      names: { "0.0.1001": "the demo wallet", [env.demo.evm]: "the demo wallet" },
    });
  });

  it("needs a session", async () => {
    expect((await app.request("/tasks")).status).toBe(401);
    expect((await app.request("/wallet")).status).toBe(401);
  });
});
