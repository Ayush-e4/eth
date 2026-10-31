import { buy, collectQuotes } from "@eth/agents/hiring";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { chats, hires, mandates, messages, users } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { hiringService } from "../hiring/service";
import { testDb } from "../test/db";
import { demoQuotas, loadDemoQuotas } from "./quotas";

vi.mock("@eth/agents/hiring", () => ({
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1, USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({ arkivReader: vi.fn(() => ({})), arkivWriter: vi.fn(() => ({})) }));

const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8" },
  demo: { key: `0x${"22".repeat(32)}`, evm: "0x0000000000000000000000000000000000000d3d" },
  mc: { publicClient: {}, chain: { id: 296 } },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  mirrorUrl: "https://mirror",
} as unknown as HiringEnv;
const small = {
  messagesPerUser: 2,
  hiresPerUser: 1,
  limitsPerUser: 1,
  limitsPerDay: 2,
  feeUnitsPerDay: 50_000n,
};

let db: Db;
const account = async () => {
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  const [c] = await db
    .insert(chats)
    .values({ userId: u?.id ?? "", title: "t" })
    .returning();
  return { userId: u?.id ?? "", chatId: c?.id ?? "" };
};
const demoLimit = (chatId: string, mandateId: bigint) =>
  db.insert(mandates).values({
    chatId,
    mandateId,
    registry: env.registry.toLowerCase(),
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees: [AIRNEST],
    demo: true,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
const paid = (chatId: string, mandateId: bigint, feeUnits: bigint) =>
  db.insert(hires).values({
    chatId,
    mandateId,
    registry: env.registry.toLowerCase(),
    skill: "flights",
    agent: AIRNEST,
    title: "AirNest",
    feeUnits,
    hederaTx: `0.0.1@${Math.random()}`,
    jobKey: "0x",
  });

beforeEach(async () => {
  vi.clearAllMocks();
  db = await testDb();
});

describe("demo quotas", () => {
  it("defaults, and settings from the environment", () => {
    expect(loadDemoQuotas({})).toMatchObject({ hiresPerUser: 5, feeUnitsPerDay: 3_000_000n });
    expect(
      loadDemoQuotas({ DEMO_HIRES_PER_DAY: "2", DEMO_FEES_TOTAL_PER_DAY_USDC: "0.5" }),
    ).toMatchObject({
      hiresPerUser: 2,
      feeUnitsPerDay: 500_000n,
    });
  });

  it("messages: a few a day per demo account", async () => {
    const q = demoQuotas(db, small);
    const a = await account();
    expect(await q.canSend(a.userId)).toBeNull();
    await db.insert(messages).values([
      { chatId: a.chatId, role: "user", text: "1" },
      { chatId: a.chatId, role: "assistant", text: "replies don't count" },
      { chatId: a.chatId, role: "user", text: "2" },
    ]);
    expect(await q.canSend(a.userId)).toContain("used today's 2 messages");
    expect((await q.left(a.userId)).messages).toBe(0);
  });

  it("limits: per account, and for the shared wallet across accounts", async () => {
    const q = demoQuotas(db, small);
    const a = await account();
    const b = await account();
    const c = await account();
    await demoLimit(a.chatId, 1n);
    expect(await q.canCreateLimit(a.userId)).toContain("set 1 spending limits today");
    expect(await q.canCreateLimit(b.userId)).toBeNull();
    await demoLimit(b.chatId, 2n);
    expect(await q.canCreateLimit(c.userId)).toContain("demo wallet has set up as many limits");
  });

  it("hires: per account, and the shared wallet's daily fee budget", async () => {
    const q = demoQuotas(db, small);
    const a = await account();
    const b = await account();
    await demoLimit(a.chatId, 1n);
    await demoLimit(b.chatId, 2n);
    expect(await q.canHire(a.chatId, 30_000n)).toBeNull();
    await paid(a.chatId, 1n, 30_000n);
    expect(await q.canHire(a.chatId, 10_000n)).toContain("used today's 1 paid hires");
    // b hasn't hired, but 0.03 + 0.03 would pass the wallet's 0.05 for the day
    expect(await q.canHire(b.chatId, 30_000n)).toContain("spent today's budget");
    expect(await q.canHire(b.chatId, 20_000n)).toBeNull();
  });

  it("a demo hire over its allowance is refused before anything is paid; wallet accounts aren't limited", async () => {
    const q = demoQuotas(db, { ...small, hiresPerUser: 0 });
    const option = {
      key: "0xq",
      agent: AIRNEST,
      title: "AirNest — f",
      note: "n",
      feeUnits: 30_000n,
      endpoint: "http://a",
    };
    vi.mocked(collectQuotes).mockResolvedValue({
      skill: "flights",
      task: "t",
      input: {},
      options: [option],
      bestReason: "",
      skipped: [],
    } as never);
    const s = hiringService(db, env, { demo: q });
    const a = await account();
    await demoLimit(a.chatId, 1n);
    const chat = { id: a.chatId, mode: "auto" as const, limitUnits: 300_000n };
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "x", "flights");
    expect(out).toMatchObject({ status: "refused" });
    expect(out.status === "refused" && out.reason).toContain("nothing paid");
    expect(buy).not.toHaveBeenCalled();

    const w = await account();
    await db.insert(mandates).values({
      chatId: w.chatId,
      mandateId: 9n,
      registry: env.registry.toLowerCase(),
      owner: "0x0000000000000000000000000000000000000abc",
      payer: "0.0.2002",
      budgetUnits: 300_000n,
      payees: [AIRNEST],
      demo: false, // the user's own wallet pays
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    vi.mocked(buy).mockRejectedValueOnce(new Error("[flights] hire failed: stop here"));
    const own = { id: w.chatId, mode: "auto" as const, limitUnits: 300_000n };
    await s.quotes(own, "flights", {});
    await s.hire(own, "q2", "x", "flights");
    expect(buy).toHaveBeenCalledOnce(); // went on to pay: no demo allowance applies
  });

  it("pauses demo hires before the shared wallet runs dry", async () => {
    const a = await account();
    await demoLimit(a.chatId, 1n);
    const low = demoQuotas(db, small, { usdcLeft: async () => 520_000n }); // 0.52 USDC left
    expect(await low.canHire(a.chatId, 30_000n)).toContain("nearly out of test USDC");
    const fine = demoQuotas(db, small, { usdcLeft: async () => 5_000_000n });
    expect(await fine.canHire(a.chatId, 30_000n)).toBeNull();
    const unknown = demoQuotas(db, small, { usdcLeft: async () => null }); // can't read it: don't block
    expect(await unknown.canHire(a.chatId, 30_000n)).toBeNull();
  });
});
