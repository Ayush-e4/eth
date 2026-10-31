import { buy, collectQuotes } from "@eth/agents/hiring";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { hiringService } from "./service";

// A restart = a new service on the same database. Nothing a chat is in the middle of is lost.

vi.mock("@eth/agents/hiring", () => ({
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1, USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
}));

const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8" },
  demo: { key: `0x${"22".repeat(32)}`, evm: "0x0000000000000000000000000000000000000d3d" },
  mc: { publicClient: {}, chain: { id: 296 } },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  mirrorUrl: "https://mirror",
} as unknown as HiringEnv;
const option = {
  key: "0xquote",
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹14,282",
  feeUnits: 30_000n,
  endpoint: "http://a",
  priced: { feeUnits: 30_000n, totalInr: 14_285 },
};
const roundFor = (task: string, key = option.key) => ({
  skill: "flights",
  task,
  input: { origin: "BOM", adults: 1 },
  options: [{ ...option, key }],
  bestReason: "lowest total",
  skipped: [],
});

let db: Db;
let chat: Awaited<ReturnType<ReturnType<typeof chatStore>["create"]>>;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(collectQuotes).mockImplementation(async (_s, task) => roundFor(task) as never);
  vi.mocked(buy).mockResolvedValue({
    skill: "flights",
    agent: AIRNEST,
    agentTitle: "AirNest",
    quoteNote: "IX1163",
    feeUnits: 30_000n,
    hederaTx: "0.0.1001@1.2",
    jobKey: "0xjob",
    result: { ref: "FH-1" },
  } as never);
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  chat = await chatStore(db).create(u as never);
  await db.insert(mandates).values({
    chatId: chat.id,
    mandateId: 7n,
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees: [AIRNEST],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
});

describe("hiring across a restart", () => {
  it("a quote held before the restart can be hired after it, exactly as quoted", async () => {
    const { refs } = await hiringService(db, env).quotes(chat, "flights", {});
    expect(refs.map((r) => r.ref)).toEqual(["q1"]);

    const after = hiringService(db, env); // restarted
    expect((await after.hire(chat, "q1", "x", "flights")).status).toBe("hired");
    const [round, picked] = vi.mocked(buy).mock.calls[0] ?? [];
    expect(picked).toEqual(roundFor(round?.task ?? "").options[0]); // bigints intact
    expect(round?.input).toEqual({ origin: "BOM", adults: 1 });
  });

  it("refs keep counting up, so an old ref in the conversation never means a new quote", async () => {
    await hiringService(db, env).quotes(chat, "flights", {});
    vi.mocked(collectQuotes).mockImplementationOnce(
      async (_s, task) => roundFor(task, "0xother") as never,
    );
    const { refs } = await hiringService(db, env).quotes(chat, "flights", {});
    expect(refs.map((r) => r.ref)).toEqual(["q2"]);
  });

  it("an approval given before the restart still pays once after it", async () => {
    const ask = { ...chat, mode: "ask" as const };
    const before = hiringService(db, env);
    await before.quotes(ask, "flights", {});
    const first = await before.hire(ask, "q1", "x", "flights");
    const code = first.status === "needs_approval" ? first.card.code : "";
    expect(code).toMatch(/^[0-9a-f]{6}$/);

    const after = hiringService(db, env);
    expect(await after.pendingApproval(chat.id, code)).toBe(true);
    await after.noteUserMessage(chat.id, `Approve ${code}`);
    expect((await after.hire(ask, "q1", "x", "flights")).status).toBe("hired");
    // spent: the same approval can't pay again, on this instance or another
    await hiringService(db, env).quotes(ask, "flights", {});
    expect((await hiringService(db, env).hire(ask, "q2", "x", "flights")).status).toBe(
      "needs_approval",
    );
  });
});
