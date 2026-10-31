import { buy, collectQuotes } from "@eth/agents/hiring";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { chats, hires, mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import { AIRNEST, env, option, round } from "../test/hiring";
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

const NAMES: Record<string, string> = { [AIRNEST]: "AirNest" };
const giveMandate = (payees: string[]) =>
  db.insert(mandates).values({
    chatId: chat.id,
    mandateId: 7n,
    registry: env.registry.toLowerCase(),
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees,
    // as when the user approved the limit card: the names it showed
    payeeNames: Object.fromEntries(payees.map((p) => [p.toLowerCase(), NAMES[p] ?? p])),
    expiresAt: new Date(Date.now() + 3_600_000),
  });

describe("hiring from a chat", () => {
  it("hands out short quote refs", async () => {
    const s = hiringService(db, env);
    const { refs } = await s.quotes(chat, "flights", { origin: "BOM" });
    expect(refs.map((r) => r.ref)).toEqual(["q1"]);
  });

  it("leaves out an agent an admin hid", async () => {
    vi.mocked(collectQuotes).mockResolvedValueOnce(structuredClone(round) as never); // own copy
    const s = hiringService(db, env, { hidden: (a) => a.toLowerCase() === AIRNEST.toLowerCase() });
    const out = await s.quotes(chat, "flights", {});
    expect(out.refs).toEqual([]);
    expect(out.round.skipped.at(-1)).toMatch(/not offered on AgentNet/);
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

  it("ignores a limit left on an older registry: it asks for a new one", async () => {
    await giveMandate([AIRNEST.toLowerCase()]);
    await db.update(mandates).set({ registry: "0x00000000000000000000000000000000000000aa" });
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

  it("paid on delivery: paid out at once, or held for the user's review first", async () => {
    await giveMandate([AIRNEST]);
    const escrow = { id: "0xe5", deliveredTx: "0.0.5005@7.7" };
    const base = await (buy as unknown as () => Promise<object>)(); // the usual hire
    vi.mocked(buy).mockResolvedValue({ ...base, escrow } as never);
    const release = vi.fn();
    const withEscrow = { ...env, escrow: { release, dispute: vi.fn(), read: vi.fn() } };
    const s = hiringService(db, withEscrow);
    await s.quotes(chat, "flights", {});
    const out = await s.hire(chat, "q1", "x", "flights");
    expect(out.status === "hired" && out.card.escrow).toEqual(escrow);
    expect(vi.mocked(buy).mock.calls.at(-1)?.[3]).toMatchObject({ release });

    const hold = vi.fn(async () => new Date("2026-11-01T10:02:00Z"));
    const reviewed = hiringService(db, withEscrow, { review: { hold } as never });
    await reviewed.quotes(chat, "flights", {});
    const held = await reviewed.hire(chat, "q2", "x", "flights");
    expect(held.status === "hired" && held.card.escrow?.reviewUntil).toBe(
      "2026-11-01T10:02:00.000Z",
    );
    expect(hold).toHaveBeenCalledWith(chat.id, "0xe5", "AirNest");
    expect(vi.mocked(buy).mock.calls.at(-1)?.[3]).not.toHaveProperty("release");
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

    await s.noteUserMessage(chat.id, "Approve zzzzzz"); // wrong code: nothing happens
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("needs_approval");

    await s.noteUserMessage(chat.id, `Approve ${code}`);
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("hired");
    expect(buy).toHaveBeenCalledOnce();
  });

  it("a declined approval doesn't pay", async () => {
    await giveMandate([AIRNEST]);
    const ask = { ...chat, mode: "ask" as const };
    const s = hiringService(db, env);
    await s.quotes(ask, "flights", {});
    const first = await s.hire(ask, "q1", "x", "flights");
    await s.noteUserMessage(
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

    await s.noteUserMessage(chat.id, `Approve ${code}`); // typed, but no human check yet
    expect((await s.hire(ask, "q1", "x", "flights")).status).toBe("needs_approval");
    expect(buy).not.toHaveBeenCalled();

    const again = await s.hire(ask, "q1", "x", "flights");
    const code2 = again.status === "needs_approval" ? again.card.code : "";
    expect(await s.pendingApproval(chat.id, code2)).toBe(true);
    await s.markHuman(chat.id, code2);
    await s.noteUserMessage(chat.id, `Approve ${code2}`);
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
    await s.markHuman(chat.id, code);
    await s.noteUserMessage(chat.id, `Approve ${code}`);
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
