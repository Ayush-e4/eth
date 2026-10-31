import { buy, collectQuotes, type JobView, recordHire } from "@eth/agents/hiring";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { hires, mandates, messages, pendingHires as table, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { pendingHires } from "./pending";
import { hiringService } from "./service";

vi.mock("@eth/agents/hiring", () => ({
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  recordHire: vi.fn(),
  readJob: vi.fn(),
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
const option = {
  key: "0xquote",
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹3,800",
  feeUnits: 30_000n,
  endpoint: "http://airnest",
};
const round = {
  skill: "flights",
  task: "t",
  input: {},
  options: [option],
  bestReason: "",
  skipped: [],
};
const hire = {
  skill: "flights",
  agent: AIRNEST,
  agentTitle: "AirNest — budget flights",
  endpoint: "http://airnest",
  quoteNote: "IX1163",
  feeUnits: 30_000n,
  choice: "x",
  hederaTx: "0.0.1001@5.5?scheduled",
  jobKey: "0xjob",
  result: { ref: "FH-9" },
  rejected: [],
};
const job = (over: Partial<JobView>): JobView => ({
  job: "0xquote",
  status: "delivered",
  agent: "AirNest",
  payTo: "0.0.5005",
  paymentTx: "0.0.1001@5.5?scheduled",
  result: { ref: "FH-9" },
  ...over,
});

let db: Db;
let chatId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(recordHire).mockResolvedValue(hire as never);
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  chatId = (await chatStore(db).create(u as never)).id;
});

const begin = (p: ReturnType<typeof pendingHires>) =>
  p.begin({
    chatId,
    mandateId: 7n,
    payer: "0.0.1001",
    round: round as never,
    option: option as never,
    label: "flights",
    reason: "cheapest",
  });
const said = async () =>
  (await db.select().from(messages).where(eq(messages.chatId, chatId))).map((m) => m.text);
const left = async () => (await db.select().from(table)).length;

describe("hires followed after the turn lost sight of them", () => {
  it("delivered: records the hire as the turn would have, and posts it with its card", async () => {
    const read = vi.fn(async () => job({}));
    const p = pendingHires(db, env, { read, wait: async () => {} });
    await p.resume(); // nothing yet
    await begin(p);
    expect(await p.resume()).toBe(1);
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(vi.mocked(recordHire).mock.calls[0]?.[5]).toEqual({
      result: { ref: "FH-9" },
      hederaTx: "0.0.1001@5.5?scheduled",
      payTo: "0.0.5005",
    });
    const [saved] = await db.select().from(hires);
    expect(saved).toMatchObject({ chatId, hederaTx: "0.0.1001@5.5?scheduled", feeUnits: 30_000n });
    const [m] = await db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(m?.text).toContain("AirNest finished the job from earlier");
    expect(m?.cards[0]).toMatchObject({ type: "hired", hederaTx: "0.0.1001@5.5?scheduled" });
  });

  it("failed: says so in a readable line, with the refund", async () => {
    const supplier = `Duffel /air/orders → HTTP 422: {"errors":[{"title":"Requested offer is no longer available","code":"x"}]}`;
    const p0 = pendingHires(db, env, {
      read: async () =>
        job({ status: "failed", detail: supplier, refund: { transaction: "0.0.5005@1.1" } }),
      wait: async () => {},
    });
    p0.follow(await begin(p0));
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(await said()).toEqual([
      "AirNest couldn't finish the job from earlier: requested offer is no longer available; the fee was refunded (0.0.5005@1.1).",
    ]);
  });

  it("failed: a plain reason is kept as is", async () => {
    const read = vi.fn(async () =>
      job({ status: "failed", detail: "sold out", refund: { transaction: "0.0.5005@9.9" } }),
    );
    const p = pendingHires(db, env, { read, wait: async () => {} });
    p.follow(await begin(p));
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(await said()).toEqual([
      "AirNest couldn't finish the job from earlier: sold out; the fee was refunded (0.0.5005@9.9).",
    ]);
    expect(await db.select().from(hires)).toEqual([]);
  });

  it("the agent has no job for it: nothing was paid, nothing to say", async () => {
    const p = pendingHires(db, env, { read: async () => null, wait: async () => {} });
    p.follow(await begin(p));
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(await said()).toEqual([]);
  });

  it("keeps asking while the agent is unreachable or still working", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(job({ status: "working" }))
      .mockResolvedValueOnce(job({}));
    const wait = vi.fn(async () => {});
    const p = pendingHires(db, env, { read, wait });
    p.follow(await begin(p));
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(wait).toHaveBeenCalledTimes(2);
    expect(await said()).toHaveLength(1);
  });

  it("doesn't record a hire twice when the turn already did", async () => {
    await db.insert(hires).values({
      ...hire,
      chatId,
      mandateId: 7n,
      registry: env.registry.toLowerCase(),
      title: "AirNest",
    });
    const p = pendingHires(db, env, { read: async () => job({}), wait: async () => {} });
    p.follow(await begin(p));
    await vi.waitFor(async () => expect(await left()).toBe(0));
    expect(recordHire).not.toHaveBeenCalled();
    expect(await db.select().from(hires)).toHaveLength(1);
  });
});

describe("a turn whose hire outlasts it", () => {
  it("answers 'pending', keeps the hire written down and follows it", async () => {
    await db.insert(mandates).values({
      chatId,
      mandateId: 7n,
      registry: env.registry.toLowerCase(),
      owner: env.demo.evm,
      payer: "0.0.1001",
      budgetUnits: 300_000n,
      payees: [AIRNEST],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    vi.mocked(collectQuotes).mockResolvedValue(round as never);
    vi.mocked(buy).mockRejectedValue(
      Object.assign(new Error("still working"), { name: "HirePending" }),
    );
    const read = vi.fn(async () => new Promise<never>(() => {})); // the agent takes its time
    const pending = pendingHires(db, env, { read, wait: async () => {} });
    const s = hiringService(db, env, { pending });
    const chat = { id: chatId, mode: "auto" as const, limitUnits: 300_000n };
    await s.quotes(chat, "flights", {});
    expect(await s.hire(chat, "q1", "x", "flights")).toMatchObject({ status: "pending" });
    expect(await left()).toBe(1);
    await vi.waitFor(() =>
      expect(read).toHaveBeenCalledWith("http://airnest", "0xquote", expect.anything()),
    );

    vi.mocked(buy).mockRejectedValueOnce(new Error("[flights] hire failed: HTTP 402 no"));
    await s.quotes(chat, "flights", {});
    expect(await s.hire(chat, "q2", "x", "flights")).toMatchObject({ status: "refused" });
    expect(await left()).toBe(1); // a hire that clearly failed isn't kept
  });
});
