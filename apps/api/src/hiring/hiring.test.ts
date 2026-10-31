import { buy, collectQuotes } from "@eth/agents/hiring";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { chats, hires, mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { hiringService } from "./service";

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
  demo: {
    key: `0x${"22".repeat(32)}`,
    evm: "0x0000000000000000000000000000000000000d3d",
    account: "0.0.1001",
  },
  mc: { publicClient: {}, chain: { id: 296 } },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  usdc: "0x0000000000000000000000000000000000068cda",
  usdcTokenId: "0.0.429274",
  mirrorUrl: "https://mirror",
} as unknown as HiringEnv;

const option = {
  key: "0xquote",
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹14,282",
  feeUnits: 30_000n,
  endpoint: "http://a",
};
const round = {
  skill: "flights",
  task: "t",
  input: {},
  options: [option],
  bestReason: "lowest total",
  skipped: [],
};

let db: Db;
let chat: Awaited<ReturnType<ReturnType<typeof chatStore>["create"]>>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(collectQuotes).mockResolvedValue(round as never);
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
});

const giveMandate = (payees: string[]) =>
  db.insert(mandates).values({
    chatId: chat.id,
    mandateId: 7n,
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

describe("hiring from a chat", () => {
  it("hands out short quote refs", async () => {
    const s = hiringService(db, env);
    const { refs } = await s.quotes(chat, "flights", { origin: "BOM" });
    expect(refs.map((r) => r.ref)).toEqual(["q1"]);
  });

  it("asks for a spending limit naming the quoting agents before paying anyone", async () => {
    const s = hiringService(db, env);
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "cheapest", "flights");
    expect(out.status).toBe("needs_limit");
    expect(out.status === "needs_limit" && out.card).toMatchObject({
      budgetUnits: "300000",
      perPaymentCapUnits: "100000",
      agent: env.concierge.evm,
      payees: [{ name: "AirNest", agent: AIRNEST }],
    });
    expect(buy).not.toHaveBeenCalled();
  });

  it("won't pay an agent the mandate doesn't allow", async () => {
    await giveMandate(["0x1111111111111111111111111111111111111111"]);
    const s = hiringService(db, env);
    await s.quotes(chat, "flights", {});
    expect((await s.hire(chat, "q1", "x", "flights")).status).toBe("needs_limit");
    expect(buy).not.toHaveBeenCalled();
  });

  it("hires in an auto chat once the mandate covers the agent, and records it", async () => {
    await giveMandate([AIRNEST.toLowerCase()]);
    const rate = vi.fn(async (): Promise<`0x${string}` | null> => "0xreview");
    const s = hiringService(db, env, { reputation: { rate } });
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "cheapest", "flights");
    expect(out).toMatchObject({
      status: "hired",
      card: { hederaTx: "0.0.1001@1.2", feeUnits: "30000" },
    });
    expect(vi.mocked(buy).mock.calls[0]?.[3]).toMatchObject({ mandateId: 7n, payer: "0.0.1001" });
    expect(rate).toHaveBeenCalledOnce(); // the payer reviews the agent on ERC-8004
    expect((await s.hire(chat, "q1", "again", "flights")).status).toBe("refused"); // quote used up
  });

  it("writes each hire to the public spend log and links its entry from the card", async () => {
    await giveMandate([AIRNEST]);
    const write = vi.fn(async () => 12);
    const s = hiringService(db, { ...env, log: { topicId: "0.0.99", write } });
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "x", "flights");
    expect(out.status === "hired" && out.card.log).toEqual({ topic: "0.0.99", seq: 12 });
    expect(write).toHaveBeenCalledWith({
      kind: "agentnet.hired",
      mandateId: "7",
      skill: "flights",
      agent: AIRNEST,
      fee: "30000",
      payment: "0.0.1001@1.2",
      job: "0xjob",
    });
    expect((await db.select().from(hires))[0]?.logSeq).toBe(12);
  });

  it("still hires when the log write fails, just without an entry", async () => {
    await giveMandate([AIRNEST]);
    const s = hiringService(db, { ...env, log: { topicId: "0.0.99", write: async () => null } });
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "x", "flights");
    expect(out.status === "hired" && out.card.log).toBeUndefined();
    expect((await db.select().from(hires))[0]?.logSeq).toBeNull();
  });

  it("in an ask chat, needs the user's approval code and spends it once", async () => {
    await giveMandate([AIRNEST]);
    const ask = { ...chat, mode: "ask" as const };
    const s = hiringService(db, env);
    await s.quotes(ask, "flights", {});
    const first = await s.hire(ask, "q1", "x", "flights");
    expect(first.status).toBe("needs_approval");
    const code = first.status === "needs_approval" ? first.card.code : "";

    s.noteUserMessage(chat.id, "Approve zzzzzz"); // wrong code: nothing happens
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("needs_approval");

    s.noteUserMessage(chat.id, `Approve ${code}`);
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("hired");
    expect(buy).toHaveBeenCalledOnce();
  });

  it("a declined approval doesn't pay", async () => {
    await giveMandate([AIRNEST]);
    const ask = { ...chat, mode: "ask" as const };
    const s = hiringService(db, env);
    await s.quotes(ask, "flights", {});
    const first = await s.hire(ask, "q1", "x", "flights");
    s.noteUserMessage(
      chat.id,
      `Decline ${first.status === "needs_approval" ? first.card.code : ""}`,
    );
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("needs_approval");
    expect(buy).not.toHaveBeenCalled();
  });

  it("reports a failed hire instead of throwing", async () => {
    await giveMandate([AIRNEST]);
    vi.mocked(buy).mockRejectedValueOnce(
      new Error("[flights] hire failed: HTTP 502 work_failed — fee refunded: 0.0.5@1"),
    );
    const s = hiringService(db, env);
    await s.quotes(chat, "flights", {});
    expect(await s.hire(chat, "q1", "x", "flights")).toEqual({
      status: "refused",
      reason: "[flights] hire failed: HTTP 502 work_failed — fee refunded: 0.0.5@1",
    });
  });
  it("asks only for what's left of the chat's limit, names agents it has seen, and stops at zero", async () => {
    await giveMandate([AIRNEST]);
    const s = hiringService(db, env);
    await s.quotes(chat, "flights", {});
    expect((await s.hire(chat, "q1", "x", "flights")).status).toBe("hired"); // spends 0.03
    const other = {
      ...option,
      agent: "0x9999999999999999999999999999999999999999",
      title: "SkyHop — x",
      key: "0xq2",
    };
    vi.mocked(collectQuotes).mockResolvedValueOnce({ ...round, options: [other] } as never);
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q2", "x", "flights");
    expect(out.status === "needs_limit" && out.card).toMatchObject({
      budgetUnits: "270000",
      payees: expect.arrayContaining([
        { name: "SkyHop", agent: other.agent },
        { name: "AirNest", agent: AIRNEST },
      ]),
    });
    await db.update(chats).set({ limitUnits: 30_000n });
    expect((await s.hire({ ...chat, limitUnits: 30_000n }, "q2", "x", "flights")).status).toBe(
      "refused",
    );
  });

  it("with World ID on, an approval only counts after a human check, for 5 minutes", async () => {
    await giveMandate([AIRNEST]);
    const ask = { ...chat, mode: "ask" as const };
    const s = hiringService(db, env, { requireHuman: true });
    await s.quotes(ask, "flights", {});
    const first = await s.hire(ask, "q1", "x", "flights");
    expect(first.status === "needs_approval" && first.card.human).toBe(true);
    const code = first.status === "needs_approval" ? first.card.code : "";

    s.noteUserMessage(chat.id, `Approve ${code}`); // typed, but no human check yet
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("needs_approval");
    expect(buy).not.toHaveBeenCalled();

    const again = await s.hire(ask, "q1", "x", "flights");
    const code2 = again.status === "needs_approval" ? again.card.code : "";
    expect(s.pendingApproval(chat.id, code2)).toBe(true);
    s.markHuman(chat.id, code2);
    s.noteUserMessage(chat.id, `Approve ${code2}`);
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("hired");
    expect(buy).toHaveBeenCalledOnce();
  });

  it("keeps a human-verified approval when the quote lapses and the same agent re-quotes", async () => {
    await giveMandate([AIRNEST]);
    const ask = { ...chat, mode: "ask" as const };
    const s = hiringService(db, env, { requireHuman: true });
    await s.quotes(ask, "flights", {});
    const first = await s.hire(ask, "q1", "x", "flights");
    const code = first.status === "needs_approval" ? first.card.code : "";
    s.markHuman(chat.id, code);
    s.noteUserMessage(chat.id, `Approve ${code}`);
    // the check took a while: fresh quotes (a new quote key, so a new ref), same agent and fee
    const requote = (key: string) =>
      vi
        .mocked(collectQuotes)
        .mockResolvedValueOnce({ ...round, options: [{ ...option, key }] } as never);
    requote("0xquote2");
    await s.quotes(ask, "flights", {});
    expect((await s.hire(ask, "q2", "x", "flights")).status).toBe("hired");
    expect(buy).toHaveBeenCalledOnce();
    // and it paid once: another hire needs a new approval
    requote("0xquote3");
    await s.quotes(ask, "flights", {});
    expect((await s.hire(ask, "q3", "x", "flights")).status).toBe("needs_approval");
  });
});
